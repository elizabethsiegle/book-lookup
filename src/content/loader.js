// Manifest-declared content scripts are classic scripts and cannot use static
// import. Bootstrap the real ES module from web_accessible_resources.
(async () => {
  const module = await import(chrome.runtime.getURL('src/content/runner.js'));
  await module.run();
})().catch(() => {
  // A failed bootstrap must leave the page exactly as it found it.
});
