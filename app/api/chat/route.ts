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
    
    if (!llmProvider) {
      return NextResponse.json({ error: "No provider selected" }, { status: 400 });
    }

    // Build model string based on provider type
    let modelString = "azure/gpt-4o-mini"; // Default fallback
    
    if (llmProvider.type === "azure") {
      modelString = `azure/${llmProvider.model}`;
    } else if (llmProvider.type === "openai") {
      modelString = `openai/${llmProvider.model}`;
    } else if (llmProvider.type === "anthropic") {
      modelString = `anthropic/${llmProvider.model}`;
    } else if (llmProvider.type === "groq") {
      modelString = `groq/${llmProvider.model}`;
    } else if (llmProvider.type === "ollama") {
      modelString = `ollama/${llmProvider.model}`;
    } else if (llmProvider.type === "deepseek") {
      modelString = `deepseek/${llmProvider.model}`;
    } else if (llmProvider.type === "custom") {
      modelString = llmProvider.model;
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
      } catch (e) {
        // Handle closed connection
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

      // Stream clean progress log to Web UI
      sendPayload("progress", message);
    };

    // Asynchronously run scraper agent and stream progress
    const runScraper = async () => {
      let stagehandInstance: any = null;
      const allExtractedItems: any[] = [];
      const timestamp = Date.now();
      const incrementalFile = `results/web_chat_${timestamp}_incremental.json`;

      try {
        console.log("⏳ Initializing Stagehand with Headless Lightpanda Browser...");
        
        // Initialize browser Setup
        const browserSetup = await initializeBrowser();
        stagehandInstance = browserSetup.stagehand;
        const page = browserSetup.page;

        console.log(`🤖 Setting up tools for prompt: "${prompt}"`);
        
        // Instantiate tools
        const tools: any = {
          analyzePage: createPageAnalysisTool(page),
          generateSchema: createSchemaGenerationTool(page),
          extractWithSchema: createSchemaExtractionTool(
            page, 
            allExtractedItems, 
            incrementalFile, 
            { prompt, url: null }
          ),
          searxngSearch: createSearchTool()
        };

        console.log(`🤖 Creating Stagehand AI Agent with ${providerLabel}...`);
        const agent = createAgent(stagehandInstance, tools, false, modelString);

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
        await sendPayload("result", items);

      } catch (err: any) {
        console.log(`❌ Scraper Thread Error: ${err.message}`);
        await sendPayload("progress", `❌ Error during run: ${err.message}`);
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
        
        try {
          await writer.close();
        } catch (e) {
          // Ignore writer issues
        }
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
