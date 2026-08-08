'use strict';

const moveLocale = require('./move-locale');
const config = require('./config');
const dataTransfer = require('./data-transfer');

module.exports = {
  'move-locale': moveLocale,
  config,
  'data-transfer': dataTransfer,
};
