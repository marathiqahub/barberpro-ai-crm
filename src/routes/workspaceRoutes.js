const express = require('express');

// Kept as a compatibility factory for downstream imports. Role-specific workspace
// endpoints live exclusively in dashboardRoutes to avoid route shadowing.
function createWorkspaceRouter() {
  return express.Router();
}

module.exports = { createWorkspaceRouter };
