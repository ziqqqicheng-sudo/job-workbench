// /api/jobs.js
// Vercel Function: receives the job-search profile from the frontend,
// queries Google via Serper.dev, normalizes results, and returns job-like records.

const SERPER_URL = "https://google.serper.dev/search";

function clean(s="") {
  return String(s).replace(/\s+/g, " ").trim();
}

function hostname(url="") {
  try { return new URL(url).hostname.replace(/^www\./,""); } catch { return ""; }
}

function inferCompany(title="", sourceHost="") {
  const parts = title.split(/\s[-|｜–—]\s/).map(clean).filter(Boolean);
  if (parts.length >= 2) {
    // Search result titles often look like "岗位 - 公司 - 平台".
    return parts[parts.length - 1].slice(0, 40);
  }
  const map = {
    "nowcoder.com":"牛客",
    "zhipin.com":"BOSS直聘",
    "liepin.com":"猎聘",
    "51job.com":"前程无忧",
    "jobs.bytedance.com":"字节跳动",
    "career.huawei.com":"华为",
    "talent.baidu.com":"百度"
  };
  return map[sourceHost] || sourceHost || "招聘信息";
}

function inferRole(title="") {
  const parts = title.split(/\s[-|｜–—]\s/).map(clean).filter(Boolean);
  return (parts[0] || title).slice(0, 80);
}

function inferDirection(text="", directions=[]) {
  const lower = text.toLowerCase();
  for (const d of directions) if (d && lower.includes(String(d).toLowerCase())) return d;
  const presets = ["项目管理","项目运营","PMO","业务运营","商业运营","管培生","用户研究","策略","咨询"];
  return presets.find(x=>lower.includes(x.toLowerCase())) || (directions[0] || "其他");
}

function sourceName(host="") {
  if(host.includes("nowcoder")) return "牛客";
  if(host.includes("zhipin")) return "Boss直聘";
  if(host.includes("liepin")) return "猎聘";
  if(host.includes("51job")) return "前程无忧";
  if(host.includes("linkedin")) return "LinkedIn";
  if(host.includes("jobs.") || host.includes("career.") || host.includes("campus.")) return "官网";
  return host || "网络搜索";
}

function buildQueries(body={}) {
  const directions = Array.isArray(body.directions) && body.directions.length
    ? body.directions.slice(0,4)
    : ["项目管理","项目运营","PMO","业务运营"];

  const cities = clean(body.cities || "");
  const grad = clean(body.grad || "2027届");
  const industry = clean(body.industry || "");
  const kws = Array.isArray(body.keywords) ? body.keywords.slice(0,6).join(" ") : "";
  const exclude = Array.isArray(body.exclude) ? body.exclude.slice(0,6).map(x=>`-${x}`).join(" ") : "";

  return directions.map(d => {
    return clean(`${grad} 校招 应届 ${d} 招聘 ${cities} ${industry} ${kws} ${exclude}`);
  });
}

async function serperSearch(q, apiKey) {
  const r = await fetch(SERPER_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q,
      gl: "cn",
      hl: "zh-cn",
      num: 10
    })
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Serper ${r.status}: ${txt.slice(0,200)}`);
  }
  return await r.json();
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "jobs API is running",
      configured: Boolean(process.env.SERPER_API_KEY)
    });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow","GET, POST");
    return res.status(405).json({error:"Method not allowed"});
  }

  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "SERPER_API_KEY is not configured in Vercel."
    });
  }

  try {
    const body = req.body || {};
    const directions = Array.isArray(body.directions) ? body.directions : [];
    const queries = buildQueries(body);

    // Search sequentially to be gentle on rate limits and easier to debug.
    const batches = [];
    for (const q of queries) {
      const data = await serperSearch(q, apiKey);
      batches.push({q, organic: data.organic || []});
    }

    const seen = new Set();
    const jobs = [];

    for (const batch of batches) {
      for (const item of batch.organic) {
        const link = clean(item.link || "");
        const title = clean(item.title || "");
        const snippet = clean(item.snippet || "");
        if (!link || !title) continue;

        const key = link.split("#")[0].replace(/\/$/,"");
        if (seen.has(key)) continue;
        seen.add(key);

        const host = hostname(link);
        const combined = `${title} ${snippet}`;

        // Basic job-intent filter. Keep official/campus/job-board results.
        const jobish = /(招聘|校招|校园招聘|应届|graduate|campus|career|jobs|职位|岗位|管培|项目管理|运营|PMO)/i.test(combined + " " + host);
        if (!jobish) continue;

        jobs.push({
          company: inferCompany(title, host),
          role: inferRole(title),
          city: clean(body.cities || ""),
          direction: inferDirection(combined, directions),
          source: sourceName(host),
          link,
          grad: clean(body.grad || "2027届"),
          jd: snippet || title,
          status: "计划投递",
          searchQuery: batch.q
        });

        if (jobs.length >= 30) break;
      }
      if (jobs.length >= 30) break;
    }

    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      queries,
      jobs
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: "Job search failed",
      detail: e.message
    });
  }
}

