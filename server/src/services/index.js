'use strict';

const moveLocale = require('./move-locale');
const config = require('./config');
const transfer = require('./transfer');

module.exports = {
  'move-locale': moveLocale,
  config,
  transfer,
};
