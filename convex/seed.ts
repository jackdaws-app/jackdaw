import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// Dev-only demo seed. Wipes ALL tables, then inserts rich realistic data for
// the ASUS XG-C100C product page plus two skeletal products.
// Run with `npx convex run seed:demo` against the DEV deployment only.

const DAY = 24 * 60 * 60 * 1000;

type PointSpec = {
  storeNum: string;
  daysAgo: number; // firstSeenAt offset
  seenForDays: number; // lastSeenAt = firstSeenAt + seenForDays (capped at now)
  price: number;
  inStock: boolean;
  availability?: string;
  openBoxPrice?: number;
  reportCount: number;
};

export const demo = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), inserted: v.number() }),
  handler: async (ctx) => {
    // --- Wipe everything (same pattern as admin:clearAll) ---
    const tables = [
      "votes",
      "comments",
      "watches",
      "pricePoints",
      "devices",
      "products",
    ] as const;
    let deleted = 0;
    for (const table of tables) {
      const rows = await ctx.db.query(table).take(1000);
      for (const row of rows) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }

    const now = Date.now();
    let inserted = 0;

    const insertPoints = async (
      productDocId: Id<"products">,
      specs: PointSpec[],
    ) => {
      // Insert in chronological order so `.order("desc").first()` on
      // _creationTime returns the newest observation.
      const sorted = [...specs].sort((a, b) => b.daysAgo - a.daysAgo);
      for (const s of sorted) {
        const firstSeenAt = now - s.daysAgo * DAY;
        const lastSeenAt = Math.min(now, firstSeenAt + s.seenForDays * DAY);
        await ctx.db.insert("pricePoints", {
          productDocId,
          storeNum: s.storeNum,
          price: s.price,
          inStock: s.inStock,
          availability: s.availability,
          openBoxPrice: s.openBoxPrice,
          firstSeenAt,
          lastSeenAt,
          reportCount: s.reportCount,
        });
        inserted++;
      }
    };

    // --- Main product: ASUS XG-C100C ---
    const asusId = await ctx.db.insert("products", {
      productId: "481322",
      sku: "453357",
      name: "ASUS XG-C100C 10G Network Adapter PCI-E x4 Card",
      brand: "ASUS",
      category: "Wired Network Adapters",
      urlPath: "/product/481322/asus-xg-c100c-10g-network-adapter-pci-e-x4-card",
    });
    inserted++;

    // ~170 days of history across two stores. Last point per store is 99.99
    // (matches the live site) and ends at the current time.
    await insertPoints(asusId, [
      // Store 029 (7 points, one out-of-stock stretch)
      { storeNum: "029", daysAgo: 170, seenForDays: 15, price: 124.99, inStock: true, availability: "IN STOCK", reportCount: 12 },
      { storeNum: "029", daysAgo: 154, seenForDays: 23, price: 119.99, inStock: true, availability: "IN STOCK", reportCount: 22 },
      { storeNum: "029", daysAgo: 130, seenForDays: 24, price: 109.99, inStock: true, availability: "IN STOCK", openBoxPrice: 79.99, reportCount: 31 },
      { storeNum: "029", daysAgo: 105, seenForDays: 16, price: 109.99, inStock: false, availability: "SOLD OUT", reportCount: 8 },
      { storeNum: "029", daysAgo: 88, seenForDays: 27, price: 114.99, inStock: true, availability: "IN STOCK", reportCount: 18 },
      { storeNum: "029", daysAgo: 60, seenForDays: 29, price: 104.99, inStock: true, availability: "IN STOCK", reportCount: 40 },
      { storeNum: "029", daysAgo: 30, seenForDays: 999, price: 99.99, inStock: true, availability: "IN STOCK", openBoxPrice: 72.99, reportCount: 26 },
      // Store 045 (6 points, one out-of-stock stretch)
      { storeNum: "045", daysAgo: 168, seenForDays: 27, price: 124.99, inStock: true, availability: "IN STOCK", reportCount: 9 },
      { storeNum: "045", daysAgo: 140, seenForDays: 27, price: 114.99, inStock: true, availability: "IN STOCK", reportCount: 15 },
      { storeNum: "045", daysAgo: 112, seenForDays: 21, price: 114.99, inStock: false, availability: "SOLD OUT", reportCount: 5 },
      { storeNum: "045", daysAgo: 90, seenForDays: 34, price: 109.99, inStock: true, availability: "IN STOCK", reportCount: 20 },
      { storeNum: "045", daysAgo: 55, seenForDays: 29, price: 104.99, inStock: true, availability: "IN STOCK", openBoxPrice: 74.99, reportCount: 33 },
      { storeNum: "045", daysAgo: 25, seenForDays: 999, price: 99.99, inStock: true, availability: "IN STOCK", reportCount: 19 },
    ]);

    // --- 4 comments with denormalized scores + matching votes ---
    const comments: { displayName: string; body: string; score: number }[] = [
      {
        displayName: "TenGigTinkerer",
        body:
          "Grabbed an open-box one of these for $73 at the Tustin store — box was beat up but the card was sealed in the anti-static bag with the low-profile bracket still included. Aquantia AQC107 chip runs warm, so give it some airflow, but I've been saturating 10GbE to my NAS for months. Ask at the service desk, they don't always shelve the open-box stock.",
        score: 15,
      },
      {
        displayName: "DanFromDenver",
        body:
          "Price matched this against Amazon's $94.99 listing last month with zero hassle — showed the listing at the counter and they knocked it down on the spot. Micro Center's price match is same-day delivery-eligible retailers only, so check the fine print first.",
        score: 9,
      },
      {
        displayName: "HomeLabHeather",
        body:
          "Heads up: the shelf tag at store 045 said sold out for like three weeks in spring but they had two behind the counter as returns-restock. Worth asking an associate even when the website shows out of stock.",
        score: 5,
      },
      {
        displayName: "PCIePatrick",
        body:
          "Works fine in a x4 slot off the chipset, don't waste a CPU slot on it. Windows grabbed a driver automatically but get the newer Marvell/Aquantia one from ASUS's site — the inbox driver had flow control issues for me.",
        score: 3,
      },
    ];
    let voterSeq = 0;
    const insertComment = async (c: {
      displayName: string;
      body: string;
      score: number;
      parentId?: Id<"comments">;
    }): Promise<Id<"comments">> => {
      const commentId = await ctx.db.insert("comments", {
        productDocId: asusId,
        deviceId: `seed-author-${c.displayName}`,
        displayName: c.displayName,
        body: c.body,
        score: c.score,
        voteCount: c.score, // all upvotes, so voteCount === score
        parentId: c.parentId,
      });
      inserted++;
      for (let i = 0; i < c.score; i++) {
        await ctx.db.insert("votes", {
          commentId,
          deviceId: `seed-voter-${voterSeq++}`,
          value: 1,
        });
        inserted++;
      }
      return commentId;
    };

    const topLevelIds: Id<"comments">[] = [];
    for (const c of comments) {
      topLevelIds.push(await insertComment(c));
    }

    // --- Threaded replies under the open-box tip (TenGigTinkerer) ---
    const openBoxThreadId = topLevelIds[0];
    await insertComment({
      displayName: "DanFromDenver",
      body:
        "Seconding the service-desk tip — Tustin had three more in the back when I asked. Mine came with both brackets too.",
      score: 4,
      parentId: openBoxThreadId,
    });
    const heatsinkReplyId = await insertComment({
      displayName: "NASNerdNina",
      body:
        "How warm is warm? Mine idles around 70C in a cramped ITX case even with the stock heatsink. Wondering if I got a dud or if that's just the AQC107.",
      score: 2,
      parentId: openBoxThreadId,
    });
    await insertComment({
      displayName: "TenGigTinkerer",
      body:
        "70C idle is on the high side but within spec — the AQC107 throttles around 100C. Zip-tie a 40mm fan to the heatsink and it'll drop 20C easy.",
      score: 3,
      parentId: heatsinkReplyId,
    });

    // --- Skeletal product 2: Logitech USB Unifying Receiver ---
    const logiId = await ctx.db.insert("products", {
      productId: "481336",
      sku: "460988",
      name: "Logitech USB Unifying Receiver",
      brand: "Logitech",
      category: "Mouse & Keyboard Accessories",
      urlPath: "/product/481336/logitech-usb-unifying-receiver",
    });
    inserted++;
    await insertPoints(logiId, [
      { storeNum: "029", daysAgo: 95, seenForDays: 40, price: 14.99, inStock: true, availability: "IN STOCK", reportCount: 6 },
      { storeNum: "029", daysAgo: 50, seenForDays: 30, price: 12.99, inStock: true, availability: "IN STOCK", reportCount: 11 },
      { storeNum: "029", daysAgo: 18, seenForDays: 999, price: 14.99, inStock: true, availability: "IN STOCK", reportCount: 4 },
    ]);

    // --- Skeletal product 3: Samsung 980 PRO 1TB ---
    const ssdId = await ctx.db.insert("products", {
      productId: "637504",
      sku: "637504",
      name: "Samsung 980 PRO 1TB PCIe 4.0 NVMe M.2 Internal SSD",
      brand: "Samsung",
      category: "Solid State Drives",
      urlPath: "/product/637504/samsung-980-pro-1tb-pcie-40-nvme-m2-internal-ssd",
    });
    inserted++;
    await insertPoints(ssdId, [
      { storeNum: "045", daysAgo: 120, seenForDays: 45, price: 129.99, inStock: true, availability: "IN STOCK", reportCount: 24 },
      { storeNum: "045", daysAgo: 70, seenForDays: 35, price: 109.99, inStock: true, availability: "IN STOCK", openBoxPrice: 84.99, reportCount: 37 },
      { storeNum: "045", daysAgo: 32, seenForDays: 20, price: 119.99, inStock: false, availability: "SOLD OUT", reportCount: 7 },
      { storeNum: "045", daysAgo: 10, seenForDays: 999, price: 99.99, inStock: true, availability: "IN STOCK", reportCount: 13 },
    ]);

    return { deleted, inserted };
  },
});
