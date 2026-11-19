/* Pure snapshot/trace helpers. No DOM or application mutations. */
(function (root) {
  "use strict";
  const labels = {
    candidate: "候选 flag · 未核验", accepted_receipt: "通过回执（文本）",
    rejected: "拒收/否决", negated: "否定陈述", unverified: "未核验文本",
    test_record: "自测/占位记录 · 不计成功",
  };
  const fingerprint = node => JSON.stringify(node);
  function diffGraphs(before, after) {
    const result = {newFacts: [], newIntents: [], concluded: [], changedFacts: [], removedFacts: [], removedIntents: [], stateChanges: [], projectChanged: false, hintsChanged: false};
    if (!before || before.project.id !== after.project.id) return {...result, changed: false};
    const facts = new Map(before.facts.map(f => [f.id, f]));
    const intents = new Map(before.intents.map(i => [i.id, i]));
    const freshFacts = new Set(after.facts.map(f => f.id));
    const freshIntents = new Set(after.intents.map(i => i.id));
    for (const fact of after.facts) {
      const old = facts.get(fact.id);
      if (!old) result.newFacts.push(fact.id);
      else if (old.description !== fact.description || old.source_intent !== fact.source_intent || old.evidence_status !== fact.evidence_status) result.changedFacts.push(fact.id);
    }
    for (const intent of after.intents) {
      const old = intents.get(intent.id);
      if (!old) result.newIntents.push(intent.id);
      else {
        if (!old.concluded_at && intent.concluded_at) result.concluded.push(intent.id);
        if (old.execution_state !== intent.execution_state || old.worker !== intent.worker || old.description !== intent.description || old.to_fact_id !== intent.to_fact_id) result.stateChanges.push(intent.id);
      }
    }
    result.removedFacts = [...facts.keys()].filter(id => !freshFacts.has(id));
    result.removedIntents = [...intents.keys()].filter(id => !freshIntents.has(id));
    result.projectChanged = before.project.status !== after.project.status || before.project.title !== after.project.title;
    result.hintsChanged = fingerprint(before.hints || []) !== fingerprint(after.hints || []);
    result.changed = Object.values(result).some(value => Array.isArray(value) ? value.length > 0 : value === true);
    return result;
  }
  function diffLabel(diff) {
    const labels = [["newFacts","条新事实"],["newIntents","个新方向"],["concluded","个方向收敛"],
      ["changedFacts","条事实更新"],["removedFacts","条事实移除"],["removedIntents","个方向移除"],["stateChanges","个方向状态/内容变化"]];
    const items = labels.filter(([key]) => diff[key].length).map(([key,label]) => diff[key].length + " " + label);
    if (diff.projectChanged) items.push("项目状态/标题已更新");
    if (diff.hintsChanged) items.push("人工提示已更新");
    return items.join(" · ") || "无新增变化";
  }
  function edgeKey(edge) { return JSON.stringify([edge.type, edge.from, edge.to]); }
  function endpoints(edge) {
    return edge.type === "merge" ? ["intent:" + edge.from,"intent:" + edge.to] : edge.type === "trigger" ? ["fact:" + edge.from,"intent:" + edge.to] : ["intent:" + edge.from,"fact:" + edge.to];
  }
  function traceGraph(graph, kind, id, direction) {
    const start = kind + ":" + id;
    const nodes = new Set([start]), edges = new Map();
    // Only explicit DB edges. Time-based lane attachment is deliberately excluded.
    const rows = graph.edges || [];
    const incoming = new Map(), outgoing = new Map();
    for (const edge of rows) {
      const [from,to] = endpoints(edge);
      if (!incoming.has(to)) incoming.set(to, []);
      if (!outgoing.has(from)) outgoing.set(from, []);
      incoming.get(to).push(edge); outgoing.get(from).push(edge);
    }
    function walk(upstream) {
      const seen = new Set([start]), queue = [start];
      for (let index = 0; index < queue.length; index++) {
        for (const edge of (upstream ? incoming : outgoing).get(queue[index]) || []) {
          edges.set(edgeKey(edge), edge);
          const pair = endpoints(edge), next = pair[upstream ? 0 : 1];
          nodes.add(next);
          if (!seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
    }
    if (direction === "upstream" || direction === "both") walk(true);
    if (direction === "downstream" || direction === "both") walk(false);
    return {nodes: [...nodes], edges: [...edges.values()]};
  }
  function provenanceLabel(fact) {
    return {produced: "明确记录的产出", conclusion: "明确记录的收敛结论", time_inferred: "仅按时间推测归属（不是因果关系）",
      missing_source: "来源方向不存在：" + fact.source_intent, unassigned: "无来源记录，作为散点保留"}[fact.provenance_kind] || "项目起点/目标";
  }
  async function fetchJSON(url, timeout = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {cache: "no-store", signal: controller.signal});
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，稍后自动重试");
      throw error;
    } finally { clearTimeout(timer); }
  }
  const api = {diffGraphs, diffLabel, traceGraph, edgeKey, provenanceLabel, fetchJSON, evidenceLabel: status => labels[status] || "未核验文本"};
  root.TreeModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
