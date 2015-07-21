var fs = require('fs');
var when = require('when');
var nodefn = require('when/node');
var xml2js = require('xml2js');
var util = require('util');
var path = require('path');
var _ = require('lodash');
var mkdirp = require('mkdirp');
var randomstring = require('randomstring');
var jsdom = require('jsdom-little');
var html2jade = require('html2jade');
var request = require('request');
var url = require('url');
var sequence = require('when/sequence');

function ensureDir(filePath) {
  var dirPath = path.dirname(filePath);
  return nodefn.call(mkdirp, dirPath);
}

function fetchPage(url, retries) {
  if (retries === undefined) { retries = 3; }

  return when.promise(function (resolve, reject) {
    function retry(reason) {
      console.log(url + ' ' + reason + '. Retrying ' + retries + ' more times.');
      setTimeout(function () {
        resolve(fetchPage(url, retries - 1));
      }, 1000);
    }

    console.log(url);

    request({
      url: url,
      gzip: true,
      encoding: null,
      timeout: 10000,
    }, function(err, response, body) {
      if (retries && err && /ECONNRESET/.test(err.toString())) {
        retry('failed with ECONNRESET');
        return;
      }

      if (retries && err && /TIMEDOUT/.test(err.toString())) {
        retry('timed out');
        return;
      }

      if (err) { reject(err); return; }
      if (response.statusCode !== 200) { 
        reject(new Error('HTTP ' + response.statusCode));
        return;
      }
      resolve(body);
    });
  });
}

var downloadedPics = {};

function processPage(destDir, pageUrl, document) {
  var downloads = [];

  var images = document.getElementsByTagName('img');
  _.each(images, function (image) {
    //image.src prepends a weird '/'
    var src = image.getAttribute('src');
    if (!src) { return; }

    if (!url.parse(src).host) {
      var imageUrl = url.resolve(pageUrl, src);
      if (downloadedPics[imageUrl]) { return; }
      downloadedPics[imageUrl] = true;

      downloads.push(function () {
        return fetchPage(imageUrl).then(function (body) {
          var filePath = path.join(destDir, 'assets', src);
          return ensureDir(filePath).then(function () {
            return nodefn.call(fs.writeFile, filePath, body);
          });
        }).catch(function (err) {
          console.log(url.resolve(pageUrl, src));
          console.log(err.stack ? err.stack : err);
        });
      });
    }
  });

  return sequence(downloads).then(function () {
    return document;
  });
}

function extendNumber(nr) {
  if (nr < 10) { return '00' + nr; }
  if (nr < 100) { return '0' + nr; }
  if (nr < 1000) { return nr; }
  console.warn('Wow, you have more than 1000 chapters on one ToC level. Ordering issues might happen');
  return nr;
}

function emitJadeFile(jadePath, title, content) {
  content = '+title(' + JSON.stringify(title) + ')\n' + content;
  return ensureDir(jadePath).then(function() {
    return nodefn.call(fs.writeFile, jadePath, content);
  });
}

function generateJade(destDir, entry) {
  var jadePath = path.join(destDir, 'text', entry.jadeFile);
  console.log(jadePath);
  if (entry.url === null) {
    return emitJadeFile(jadePath, entry.title, '+no_content\n');
  }
  if (entry.url === undefined) {
    return emitJadeFile(jadePath, entry.title, '\nh1 Unknown page type\np No idea how to convert this. Sorry!\n');
  }
  return fetchPage(entry.url).then(function (html) {
    console.log(jadePath, 'fetched');
    return nodefn.call(jsdom.env.bind(jsdom), html.toString());
  }).then(function (result) {
    console.log(jadePath, 'parsed');
    return processPage(destDir, entry.url, result.document);
  }).then(function (document) {
    console.log(jadePath, 'processed');
    var html = document.getElementsByTagName('body')[0].innerHTML;
    if (!html) { return ''; }
    return nodefn.call(html2jade.convertHtml.bind(html2jade), html, { bodyless: true });
  }).catch(function (err) {
    console.log(entry.url);
    console.log(err.stack ? err.stack : err);
    var html = '<pre>' + err.stack + '</pre>';
    return nodefn.call(html2jade.convertHtml.bind(html2jade), html, { bodyless: true });
  }).then(function (jade) {
    console.log(jadePath, 'jaded');
    return emitJadeFile(jadePath, entry.title, '//- ' + entry.url + '\n\n' + jade);
  });
}

function crawlToC(textFiles, resources, prefix, node) {
  var rid = node.$.identifierref;
  var url = rid ? resources[rid] : null;
  var chapter = (node.item && node.item.length) ? (prefix + '-' + extendNumber(0)) : prefix;
  var jade = chapter.replace(/-/g, path.sep) + '.jade';
  var title = node.title ? node.title[0] : undefined;
  textFiles.push({
    title: title,
    chapter: chapter,
    jadeFile: jade,
    url: url,
  });
  _.each(node.item, function (newNode, idx) {
    crawlToC(textFiles, resources, prefix + '-' + extendNumber(idx+1), newNode);
  });
}

module.exports = function convert(sourceDir, destDir) {
  sourceDir = path.resolve(sourceDir);
  destDir = path.resolve(destDir);

  return when.try(function () {
    return nodefn.call(fs.readFile, path.join(sourceDir, 'imsmanifest.xml'));
  }).then(function (data) {
    var parser = new xml2js.Parser();
    return nodefn.call(parser.parseString.bind(parser), data);
  }).then(function (data) {
    var tocXML = data.manifest.organizations[0].organization[0];
    var resourcesXML = data.manifest.resources[0].resource;
    var resources = {};
    _.each(resourcesXML, function(resource) {
      if (resource.$.type === 'weblink') {
        resources[resource.$.identifier] = resource.$.href;
      }
    });

    var textFiles = [];
    _.each(tocXML.item, function (node, idx) {
      crawlToC(textFiles, resources, extendNumber(idx+1), node);
    });


    var metaXML = data.manifest.metadata[0].lom[0];
    var packageJson = {
      name: 'scorn-' + randomstring.generate(5),
      version: '1.0.0',
      keywords: [ 'lfa-book' ],
      book: { title: metaXML.general[0].title[0].string[0]._ },
      engines: { lfa: '^0.8.8' },
      lfa: {
        compileCore: false,
        externalPlugins: [ 'https://plugins.lfwd.io/lfa-core/0.8/plugin' ],
      }
    };

    var packageJsonPath = path.join(destDir, '.lfa', 'package.json');
    var packageJsonTask = ensureDir(packageJsonPath).then(function () {
      return nodefn.call(fs.writeFile, packageJsonPath, JSON.stringify(packageJson, null, 2));
    });

    return when.all([
      packageJsonTask,
      sequence(_.map(textFiles, function (file) {
        return generateJade.bind(null, destDir, file);
      }))
    ]);
  });
};

