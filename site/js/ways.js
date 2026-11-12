// The four ways to give tools to a model. The numbers come from data.js; the words live here.
import data from "../data.js";

const TEXT = {
  upfront: { name: "All upfront", short: "Upfront", desc: "Every tool definition is sent before the first step." },
  search: { name: "Tool search", desc: "The model searches for the tools it needs." },
  code: { name: "Code mode", desc: "The model writes a script that calls the tools." },
  mirror: { name: "Local mirror", desc: "The data is copied to a local database; the model queries it." },
};

/** Each way from data.js with its name, its description and `best: true` on the winner. */
export const ways = data.bench.ways.map((w) => ({
  name: w.id,
  desc: "",
  ...TEXT[w.id],
  ...w,
  best: w.id === data.bench.best,
}));

export function way(id) {
  const found = ways.find((w) => w.id === id);
  if (!found) throw new Error(`data.js has no way called "${id}"`);
  return found;
}
