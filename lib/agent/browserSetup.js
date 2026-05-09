/**
 * Browser Setup
 * Handles Lightpanda/Stagehand initialization and configuration
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { log } from '../utils/logUtils.js';

/**
 * Initialize Stagehand with Lightpanda
 * @returns {Promise<Object>} { stagehand, page }
 */
export async function initializeBrowser() {
  log("⏳ Initializing Stagehand with Lightpanda...", "bright");
  const cdpUrl = process.env.LIGHTPANDA_CDP_URL || "ws://127.0.0.1:9222";
  
  const stagehand = new Stagehand({
    env: "LOCAL",
    model: "azure/gpt-4o-mini",
    verbose: 1,  // Show agent's thinking
    experimental: true,  // Required for agent output schema
    domSettleTimeout: 30000,
    localBrowserLaunchOptions: {
      cdpUrl: cdpUrl,  // Connect to Lightpanda
    },
  });

  await stagehand.init();
  log("✅ Stagehand connected to Lightpanda\n", "green");
  
  // Create page explicitly for Lightpanda
  const page = await stagehand.context.newPage();
  log("✅ Page created\n", "green");
  
  return { stagehand, page };
}

/**
 * Navigate to URL if provided
 * @param {Object} page - Stagehand page object
 * @param {string|null} url - URL to navigate to
 */
export async function navigateToUrl(page, url) {
  if (!url) {
    log("ℹ️  No URL provided - agent will use SearXNG search\n", "blue");
    return;
  }
  
  log("⏳ Navigating to URL...", "yellow");
  await page.goto(url, { 
    waitUntil: 'load',
    timeout: 60000 
  });
  log("✅ Page loaded\n", "green");
}
