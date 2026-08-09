import "./background.js";
import { createPlaygroundAiMessageHandler } from "./playground-ai-host.js";

globalThis.chrome.runtime.onMessage.addListener(createPlaygroundAiMessageHandler());
