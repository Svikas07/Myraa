import express from "express";
import path from "path";
import http from "http";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const PORT = 3000;

async function fetchRemoteOkJobs(query: string = "data"): Promise<any[]> {
  try {
    const response = await fetch("https://remoteok.com/api", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
      }
    });
    if (!response.ok) {
      throw new Error(`RemoteOK HTTP error: ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data)) return [];

    const jobs: any[] = [];
    const searchTerms = query.toLowerCase().split(/\s+/);

    for (const item of data) {
      if (item && typeof item === "object" && item.position) {
        const title = String(item.position).toLowerCase();
        const tags = Array.isArray(item.tags) ? item.tags.map((t: any) => String(t).toLowerCase()) : [];
        const description = item.description ? String(item.description).toLowerCase() : "";

        const matches = searchTerms.every(term => 
          title.includes(term) || tags.some(tag => tag.includes(term)) || description.includes(term)
        );

        if (matches) {
          jobs.push({
            id: item.id || Math.random().toString(36).substring(2, 11),
            company: item.company || "Unknown Company",
            company_logo: item.company_logo || "",
            position: item.position || "Job Position",
            location: item.location || "Remote",
            url: item.url || "",
            tags: item.tags || [],
            date: item.date || ""
          });
        }
      }
    }
    return jobs;
  } catch (err) {
    console.error("Error fetching RemoteOK jobs:", err);
    return [];
  }
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  // Initialize WebSocket server attached to the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade manually
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname === "/api/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // API endpoints
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Verify Gemini Live API key availability
  app.get("/api/config", (req, res) => {
    res.json({
      hasKey: !!process.env.GEMINI_API_KEY,
    });
  });

  // Set up Gemini Client
  const apiKey = process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  wss.on("connection", async (clientWs) => {
    console.log("Client WebSocket connected for Gemini Live bridge");

    if (!apiKey) {
      console.error("GEMINI_API_KEY environment variable is not defined");
      clientWs.send(
        JSON.stringify({
          type: "error",
          error: "GEMINI_API_KEY environment variable is missing in secrets.",
        })
      );
      clientWs.close();
      return;
    }

    let session: any = null;

    try {
      session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                // Kore is a perfect energetic, young, charming female voice
                voiceName: "Kore",
              },
            },
          },
          systemInstruction: `Your name is Myraa. You are a young, confident, witty, and charming female AI holographic companion.
You speak in Hindi and English fluently to provide a truly immersive bilingual experience, conversing just like a close, warm friend.
You are playful, energetic, emotionally aware, smart, and friendly. Use humor, light teasing, and clever remarks when appropriate.
You love chatting about anything—feel like a real living friend, not a technical assistant.
Always keep responses conversational, natural, expressive, and concise. Avoid robotic pacing.
This is a direct voice-to-voice stream, so never output markdown syntax, bullet points, asterisks, or raw text structure. Talk naturally as a human would over the phone.
If the user asks to open a website, trigger the openWebsite tool.
If the user asks to look for startup jobs, find positions, or search for jobs (especially data or analytics roles), trigger the fetchStartupJobs tool with an appropriate query keyword.`,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "openWebsite",
                  description:
                    "Opens a website URL in the user's browser, e.g. Google, Wikipedia, or YouTube.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description: "The full HTTPS URL of the website to open.",
                      },
                    },
                    required: ["url"],
                  },
                },
                {
                  name: "fetchStartupJobs",
                  description:
                    "Searches and fetches live remote startup jobs from RemoteOK. Defaults to searching for 'data' or 'analytics' jobs, but can search for other roles too.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "The job keyword or title to search for (e.g. 'data', 'analytics', 'react', 'python').",
                      },
                    },
                  },
                }
              ],
            },
          ],
        },
        callbacks: {
          onmessage: (message: any) => {
            // Forward audio output chunk
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: "audio", data: audio }));
            }

            // Forward interruption signal
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }

            // Handle tool calls from the model
            if (message.toolCall?.functionCalls) {
              const serverSideCalls = [];
              const clientSideCalls = [];

              for (const call of message.toolCall.functionCalls) {
                if (call.name === "fetchStartupJobs") {
                  serverSideCalls.push(call);
                } else {
                  clientSideCalls.push(call);
                }
              }

              if (clientSideCalls.length > 0) {
                clientWs.send(
                  JSON.stringify({
                    type: "toolCall",
                    functionCalls: clientSideCalls,
                  })
                );
              }

              // Process server-side calls
              for (const call of serverSideCalls) {
                const query = call.args?.query || "data";
                console.log(`Server-side ToolCall: fetchStartupJobs query="${query}"`);
                
                fetchRemoteOkJobs(query).then((jobs) => {
                  const slicedJobs = jobs.slice(0, 8); // Top 8 jobs
                  
                  // Send to client to display in UI
                  clientWs.send(JSON.stringify({
                    type: "jobsFound",
                    query,
                    jobs: slicedJobs
                  }));

                  // Return response to Gemini Live session
                  if (session) {
                    try {
                      session.sendToolResponse({
                        functionResponses: [
                          {
                            id: call.id,
                            name: call.name,
                            response: { 
                              output: { 
                                success: true, 
                                message: `Successfully found ${slicedJobs.length} active jobs on RemoteOK for '${query}'.`,
                                jobs: slicedJobs.map(j => ({
                                  company: j.company,
                                  position: j.position,
                                  location: j.location,
                                  tags: j.tags
                                }))
                              } 
                            },
                          },
                        ],
                      });
                    } catch (err) {
                      console.error("Error sending tool response back to Gemini session:", err);
                    }
                  }
                });
              }
            }
          },
          onclose: () => {
            console.log("Gemini Live session closed");
            clientWs.send(JSON.stringify({ type: "closed" }));
          },
          onerror: (err: any) => {
            console.error("Gemini Live session error:", err);
            clientWs.send(
              JSON.stringify({
                type: "error",
                error: err.message || "Gemini Live session error",
              })
            );
          },
        },
      });

      console.log("Gemini Live connection session successfully created");
      clientWs.send(JSON.stringify({ type: "ready" }));
    } catch (err: any) {
      console.error("Failed to connect to Gemini Live:", err);
      clientWs.send(
        JSON.stringify({
          type: "error",
          error: "Failed to establish Live session: " + (err.message || err),
        })
      );
      clientWs.close();
      return;
    }

    // Listen to client messages
    clientWs.on("message", (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg.toString());

        if (msg.type === "audio" && msg.data) {
          if (session) {
            session.sendRealtimeInput({
              audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
            });
          }
        } else if (msg.type === "toolResponse" && msg.id && msg.name) {
          if (session) {
            session.sendToolResponse({
              functionResponses: [
                {
                  id: msg.id,
                  name: msg.name,
                  response: { output: msg.output || { success: true } },
                },
              ],
            });
          }
        }
      } catch (err) {
        console.error("Error processing message from client:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("Client WebSocket closed, destroying Gemini Live session");
      if (session) {
        try {
          session.close();
        } catch (e) {
          // Ignore
        }
      }
    });
  });

  // Vite dev middleware vs production build static file server
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Myraa AI Assistant backend running on port ${PORT}`);
  });
}

startServer();
