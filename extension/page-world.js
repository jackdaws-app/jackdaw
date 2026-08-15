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
    // Open-box price — the only figure on this page that genuinely differs
    // between stores, because an open-box unit is one physical item sitting at
    // one location. Micro Center prints the cheapest as "from $x.xx" in
    // #opCostNew beside the buy box, and every individual unit's price inside
    // the open-box picker modal.
    //
    // Do NOT reach for a node containing both "open box" and a price: there is
    // no such node. The elements reading "Open Box" are nav-menu links under
    // Clearance & Refurb carrying no price, and #opCostNew carries the price
    // without ever saying "open box" — so a selector demanding both matched
    // nothing, on every page, which is exactly what the original heuristic did
    // silently for its whole life. Verified 2026-08-15 against three products
    // with confirmed open-box stock: all three extracted nothing before this.
    let openBoxPrice;
    const obNodes = [
      document.querySelector("#opCostNew"),
      ...document.querySelectorAll(".openBoxModal .pricing"),
    ];
    for (const n of obNodes) {
      const m = (n?.textContent || "").match(/\$\s*([\d,]+\.?\d*)/);
      const v = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
      // Below list is the sanity check that this is a used-unit price and not
      // an accessory, bundle, or financing figure sharing the selector.
      if (!isFinite(v) || v <= 0 || v >= price) continue;
      if (openBoxPrice === undefined || v < openBoxPrice) openBoxPrice = v;
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
