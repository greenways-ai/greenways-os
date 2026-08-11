import { getDefaultKernelHost } from "./background.js";
import { GreenwaysAiService } from "./ai-service.js";
import { createChatgptAiProvider } from "./chatgpt-ai-provider.js";
import { createPlaygroundAiMessageHandler } from "./playground-ai-host.js";

const webProvider = createChatgptAiProvider({
  getKernelHost: () => getDefaultKernelHost(),
});
const aiService = new GreenwaysAiService({ webProvider });

globalThis.chrome.runtime.onMessage.addListener(createPlaygroundAiMessageHandler({
  getAiService: () => aiService,
}));
