'use strict';

const moveLocale = require('./move-locale');
const config = require('./config');
const dataTransfer = require('./data-transfer');
const dumps = require('./dumps');

module.exports = {
  'move-locale': moveLocale,
  config,
  'data-transfer': dataTransfer,
  dumps,
};
