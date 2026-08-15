// Runs in the page's MAIN world on category and search grids. Its whole job is
// to answer one question the DOM cannot: WHICH STORE is this grid priced and
// stocked for. Micro Center publishes that in its own analytics dataLayer, so
// we read it there and relay it to the isolated world. Read-only — nothing on
// the page is modified, requested, or triggered.
(() => {
  function findResultsEntry() {
    const dl = window.dataLayer;
    if (!Array.isArray(dl)) return null;
    for (const entry of dl) {
      if (entry && typeof entry === "object" && entry.page === "ProductResults") {
        return entry;
      }
    }
    return null;
  }

  function extract() {
    const e = findResultsEntry();
    if (!e) return null;
    // storeNum ONLY — deliberately not falling back to closestStoreId the way
    // the product-page reader does. "Closest" is not "selected": on a product
    // page a wrong store costs one mis-filed row, here it would file a whole
    // page of them, so no store is the better answer than a guessed one.
    const storeNum = e.storeNum ? String(e.storeNum) : "";
    if (!/^\d{1,10}$/.test(storeNum)) return null;
    return { storeNum };
  }

  // Same handshake as page-world.js: injection order between the MAIN and
  // ISOLATED worlds is not guaranteed, so re-announce until acked.
  let acked = false;
  window.addEventListener("jackdaw:catalog-ack", () => { acked = true; }, { once: true });
  let tries = 0;
  const attempt = () => {
    if (acked) return;
    // Half of page-world's budget: a grid with no ProductResults entry after
    // 10s is not a grid we should be reading, and unlike the product page
    // there is no panel waiting on the answer, so nothing is kept spinning.
    if (++tries > 20) return;
    const data = extract();
    if (data) {
      window.dispatchEvent(
        new CustomEvent("jackdaw:catalog-store", { detail: JSON.stringify(data) }),
      );
    }
    setTimeout(attempt, 500);
  };
  attempt();
})();
