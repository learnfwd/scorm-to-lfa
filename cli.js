#!/usr/bin/env node

var convert = require('./convert'); 
var assert = require('assert');

assert(process.argv.length === 4, 'usage: scorn-to-lfa <path-to-unpacked-scorn> <path-to-output>');

convert(process.argv[2], process.argv[3]);
