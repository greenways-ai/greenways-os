chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "greenways/open-studio") {
    return chrome.tabs.create({ url: chrome.runtime.getURL("src/studio.html#home") });
  }
  if (message?.type === "greenways/open-world") {
    return chrome.tabs.create({ url: chrome.runtime.getURL("src/world.html") });
  }
  return undefined;
});
