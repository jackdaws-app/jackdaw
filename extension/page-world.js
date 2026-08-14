// Runs in the page's MAIN world. Micro Center publishes product facts for its
// own analytics in window.dataLayer; we relay the ProductPage entry to the
// isolated content script via a CustomEvent. Read-only — nothing is modified.
(() => {
  function findProductEntry() {
    const dl = window.dataLayer;
    if (!Array.isArray(dl)) return null;
    for (const entry of dl) {
      if (entry && typeof entry === "object" && entry.page === "ProductPage" && entry.productID) {
        return entry;
      }
    }
    return null;
  }

  function extract() {
    const e = findProductEntry();
    if (!e) return null;
    const price = parseFloat(e.productPrice);
    if (!e.productID || !e.SKU || !isFinite(price)) return null;
    const name = (document.querySelector('[data-name]')?.getAttribute('data-name')
      || document.querySelector('h1 [itemprop="name"], h1')?.textContent
      || '').trim().slice(0, 300);
    // Best-effort open-box price: Micro Center shows "OPEN BOX ... $x.xx" near the buy box.
    let openBoxPrice;
    const obEl = [...document.querySelectorAll('a, span, div')].find(
      (n) => n.children.length === 0 && /open\s*box/i.test(n.textContent || "") && /\$\s*\d/.test(n.textContent || ""),
    );
    if (obEl) {
      const m = (obEl.textContent || "").match(/\$\s*([\d,]+\.?\d*)/);
      const v = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
      if (isFinite(v) && v > 0 && v < price) openBoxPrice = v;
    }
    return {
      openBoxPrice,
      productId: String(e.productID),
      sku: String(e.SKU),
      name: name || String(e.mpn || e.SKU),
      brand: e.brand ? String(e.brand) : undefined,
      category: e.category ? String(e.category) : undefined,
      mpn: e.mpn ? String(e.mpn) : undefined,
      ean: e.ean ? String(e.ean) : undefined,
      urlPath: String(e.pageUrl || location.pathname),
      price,
      storeNum: String(e.storeNum || e.closestStoreId || "000"),
      inStock: String(e.inStock).toLowerCase() === "true",
      availability: e.AvailabilityCode ? String(e.AvailabilityCode) : undefined,
    };
  }

  // Re-announce until the isolated content script acks — injection order
  // between the MAIN and ISOLATED worlds is not guaranteed.
  let acked = false;
  window.addEventListener("jackdaw:ack", () => { acked = true; }, { once: true });
  let tries = 0;
  const attempt = () => {
    if (acked) return;
    if (++tries > 40) {
      // 20s without a usable ProductPage entry: either this isn't a product
      // page or Micro Center changed the dataLayer shape. The isolated world
      // decides which and reports it — this is the canary for a site redesign.
      window.dispatchEvent(new CustomEvent("jackdaw:nodata"));
      return;
    }
    const data = extract();
    if (data) {
      window.dispatchEvent(new CustomEvent("jackdaw:product", { detail: JSON.stringify(data) }));
    }
    setTimeout(attempt, 500);
  };
  attempt();
})();
