"use client";

import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { ReactNode, createContext, useContext, useState } from "react";
import { LLMProvider } from "./types/provider";

// Shared Scraper state context
interface ScrapedDataContextType {
  scrapedData: any[];
  setScrapedData: (data: any[]) => void;
  logs: string[];
  setLogs: (logs: string[] | ((prev: string[]) => string[])) => void;
  isScraping: boolean;
  setIsScraping: (val: boolean) => void;
  selectedProviderId: string;
  setSelectedProviderId: (id: string) => void;
  selectedProvider: LLMProvider | undefined;
}

const ScrapedDataContext = createContext<ScrapedDataContextType | undefined>(undefined);

export function useScrapedData() {
  const context = useContext(ScrapedDataContext);
  if (!context) {
    throw new Error("useScrapedData must be used within a ScrapedDataProvider");
  }
  return context;
}

interface MyRuntimeProviderProps {
  children: ReactNode;
  selectedProviderId: string;
  setSelectedProviderId: (id: string) => void;
  selectedProvider: LLMProvider | undefined;
}

export function MyRuntimeProvider({ 
  children, 
  selectedProviderId, 
  setSelectedProviderId,
  selectedProvider 
}: MyRuntimeProviderProps) {
  const [scrapedData, setScrapedData] = useState<any[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [isScraping, setIsScraping] = useState<boolean>(false);

  const runtime = useLocalRuntime({
    async *run(options) {
      const lastMessage = options.messages[options.messages.length - 1];
      let query = "";
      if (lastMessage && lastMessage.role === "user") {
        query = lastMessage.content
          .filter((part): part is { type: "text"; text: string } => part.type === "text")
          .map(part => part.text)
          .join("");
      }

      setIsScraping(true);
      setLogs([]);
      setScrapedData([]);

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: query }],
          provider: selectedProvider,
        })
      });

      if (!response.body) {
        setIsScraping(false);
        throw new Error("No response body received from chat endpoint");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedText = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const parsed = JSON.parse(line);

              if (parsed.type === "progress") {
                const cleanMsg = parsed.message.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
                setLogs((prev) => [...prev, cleanMsg]);
                accumulatedText += cleanMsg + "\n";
                yield { content: [{ type: "text", text: accumulatedText }] };
              } else if (parsed.type === "result") {
                setScrapedData(parsed.data || []);
                setIsScraping(false);
                accumulatedText += `\n\n🎉 **Success!** Extracted ${parsed.data?.length || 0} items. View the dataset in the table browser on the left.`;
                yield { content: [{ type: "text", text: accumulatedText }] };
              }
            } catch (e) {
              accumulatedText += line + "\n";
              yield { content: [{ type: "text", text: accumulatedText }] };
            }
          }
        }
      } catch (err: any) {
        setLogs((prev) => [...prev, `❌ Stream error: ${err.message}`]);
        setIsScraping(false);
        accumulatedText += `\n\n❌ **Failed:** ${err.message}`;
        yield { content: [{ type: "text", text: accumulatedText }] };
      } finally {
        setIsScraping(false);
      }
    }
  });

  return (
    <ScrapedDataContext.Provider value={{ 
      scrapedData, 
      setScrapedData, 
      logs, 
      setLogs, 
      isScraping, 
      setIsScraping, 
      selectedProviderId, 
      setSelectedProviderId,
      selectedProvider 
    }}>
      <AssistantRuntimeProvider runtime={runtime}>
        {children}
      </AssistantRuntimeProvider>
    </ScrapedDataContext.Provider>
  );
}
