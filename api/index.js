const { createDashboard } = require('../src/dashboard/server');

module.exports = createDashboard(3000, {
  listen: false,
  localTunnel: false,
  autoStart: false,
});
