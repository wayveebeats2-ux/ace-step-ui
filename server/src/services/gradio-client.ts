import { Client } from "@gradio/client";
import { config } from '../config/index.js';

let clientInstance: Client | null = null;
let connectionPromise: Promise<Client> | null = null;

/**
 * Get a lazy-initialized Gradio client connected to the ACE-Step Gradio app.
 * Caches the connection for reuse across requests.
 */
export async function getGradioClient(): Promise<Client> {
  if (clientInstance) return clientInstance;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    try {
      const client = await Client.connect(config.acestep.apiUrl, {
        events: ["data", "status"],
      });
      clientInstance = client;
      console.log(`[Gradio] Connected to ${config.acestep.apiUrl}`);
      return client;
    } catch (error) {
      console.error(`[Gradio] Failed to connect to ${config.acestep.apiUrl}:`, error);
      throw error;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}
