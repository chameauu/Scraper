import { NextResponse } from "next/server";
import dotenv from "dotenv";
import { initializeBrowser, navigateToUrl } from "../../../lib/agent/browserSetup.js";
import { createAgent, GenericDataSchema } from "../../../lib/agent/agentConfig.js";
import { createSearchTool } from "../../../lib/tools/searchTool.js";
import { createPageAnalysisTool } from "../../../lib/tools/pageAnalysisTool.js";
import { createSchemaGenerationTool } from "../../../lib/tools/schemaGenerationTool.js";
import { createSchemaExtractionTool } from "../../../lib/tools/schemaExtractionTool.js";
import { extractItemsFromResult } from "../../../lib/utils/resultsManager.js";
import { LLMProvider } from "../../types/provider";

dotenv.config();

export async function POST(req: Request) {
  try {
    const { messages, provider } = await req.json();
    const prompt = messages[messages.length - 1].content;

    // Extract provider configuration
    const llmProvider: LLMProvider = provider;
    
    console.log("🔍 API Route - Provider received:", JSON.stringify(llmProvider, null, 2));
    
    if (!llmProvider) {
      return NextResponse.json({ error: "No provider selected" }, { status: 400 });
    }

    const providerLabel = `${llmProvider.name} (${llmProvider.model})`;

    // Use TransformStream for real-time Server-Sent Events (SSE)
    const responseStream = new TransformStream();
    const writer = responseStream.writable.getWriter();
    const encoder = new TextEncoder();

    // Helper to send typed JSON payloads to the client
    const sendPayload = async (type: "progress" | "result", data: any) => {
      try {
        const payload = JSON.stringify({ type, [type === "progress" ? "message" : "data"]: data }) + "\n";
        await writer.write(encoder.encode(payload));
      } catch (e: any) {
        // Silently ignore send errors (connection may be closed)
      }
    };

    // Keeptrack of original console.log to intercept agent/logger outputs
    const originalConsoleLog = console.log;

    // Monkeypatch console.log to capture logs from Stagehand, our tools, and third-party libs
    console.log = (...args: any[]) => {
      const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      
      // Print to terminal so user can see in Node process
      originalConsoleLog(...args);

      // Stream clean progress log to Web UI (fire and forget - don't block on errors)
      sendPayload("progress", message).catch(() => {
        // Silently ignore send errors
      });
    };

    // Asynchronously run scraper agent and stream progress
    const runScraper = async () => {
      let stagehandInstance: any = null;
      const allExtractedItems: any[] = [];
      const timestamp = Date.now();
      const incrementalFile = `results/web_chat_${timestamp}_incremental.json`;

      try {
        console.log("⏳ Initializing Stagehand with Headless Lightpanda Browser...");
        
        // Initialize browser Setup with provider configuration
        const browserSetup = await initializeBrowser(llmProvider);
        stagehandInstance = browserSetup.stagehand;
        const page = browserSetup.page;

        console.log(`🤖 Setting up tools for prompt: "${prompt}"`);
        
        // Instantiate tools (CSS schema generation disabled - using LLM only)
        const tools: any = {
          analyzePage: createPageAnalysisTool(page),
          // generateSchema: createSchemaGenerationTool(page), // DISABLED
          // extractWithSchema: createSchemaExtractionTool(     // DISABLED
          //   page, 
          //   allExtractedItems, 
          //   incrementalFile, 
          //   { prompt, url: null }
          // ),
          searxngSearch: createSearchTool()
        };

        console.log(`🤖 Creating Stagehand AI Agent with ${providerLabel}...`);
        const agent = createAgent(stagehandInstance, tools, false);

        console.log("🚀 Starting autonomous agent execution...");
        const result = await agent.execute({
          instruction: prompt,
          page: page,
          output: GenericDataSchema,
          maxSteps: 25,
        });

        console.log("✅ Agent execution complete. Processing final dataset...");
        let items = extractItemsFromResult(result);

        if (items.length === 0 && allExtractedItems.length > 0) {
          console.log(`⚠️ Agent output schema empty, but recovered ${allExtractedItems.length} items from incremental extractions!`);
          items = allExtractedItems;
        }

        console.log(`🎉 Finished! Extracted ${items.length} items successfully.`);
        
        // Save final results to JSON file
        if (items.length > 0) {
          try {
            const fs = await import('fs/promises');
            const finalFile = `results/web_chat_${timestamp}_final.json`;
            await fs.writeFile(finalFile, JSON.stringify({
              timestamp: new Date().toISOString(),
              prompt: prompt,
              provider: providerLabel,
              totalItems: items.length,
              items: items
            }, null, 2));
            console.log(`💾 Saved ${items.length} items to ${finalFile}`);
          } catch (saveErr: any) {
            console.log(`⚠️ Failed to save results: ${saveErr.message}`);
          }
        }
        
        // Send result
        await sendPayload("result", items);
        // Give a small delay to ensure the result payload is sent
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (err: any) {
        console.log(`❌ Scraper Thread Error: ${err.message}`);
        await sendPayload("progress", `❌ Error during run: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      } finally {
        // Restore original console.log immediately
        console.log = originalConsoleLog;

        if (stagehandInstance) {
          try {
            await stagehandInstance.close();
            originalConsoleLog("✅ Closed headless browser session.");
          } catch (e) {
            // Ignore close issues
          }
        }
        
        // Close the writer after a small delay to ensure all data is sent
        setTimeout(async () => {
          try {
            await writer.close();
          } catch (e) {
            // Ignore writer close issues
          }
        }, 200);
      }
    };

    // Spawn scraper execution thread in background so Next.js HTTP response returns stream instantly
    runScraper();

    return new Response(responseStream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
