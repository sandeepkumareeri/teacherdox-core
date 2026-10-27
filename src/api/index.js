'use strict';
// TeacherDox Core REST API: createApi (handler + listen), createStore, start (from env).

module.exports = {
  ...require('./server'),
  ...require('./store'),
  ...require('./main'),
};
