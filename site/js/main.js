// Entry point: fills the numbers, then starts each part of the page.
import { $ } from "./util.js";
import { fillValues } from "./values.js";
import { initIntro } from "./intro.js";
import { initCopy } from "./copy.js";
import { initArt } from "./art.js";
import { initServers } from "./servers.js";
import { initBench } from "./bench.js";

initIntro();
fillValues();
initCopy();
initArt($("#art"));
initServers();
initBench();
