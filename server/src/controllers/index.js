'use strict';

const moveLocale = require('./move-locale');
const config = require('./config');
const transfer = require('./transfer');
const dataTransfer = require('./data-transfer');

module.exports = {
  'move-locale': moveLocale,
  config,
  transfer,
  'data-transfer': dataTransfer,
};
