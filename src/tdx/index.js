'use strict';
// @teacherdox/tdx — reference implementation of the .tdx 2.0 universal teaching record.

module.exports = {
  ...require('./canonical'),
  ...require('./crypto'),
  ...require('./capsule'),
  ...require('./verify'),
  ...require('./seal'),
  ...require('./schema'),
};
