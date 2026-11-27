// Downloads the local AI models Cerebra uses (all run on the computer, offline):
//   ocr/     PaddleOCR PP-OCRv6 small (Apache-2.0): reads scanned PDFs and pictures
//   embed/   BGE-small-en v1.5, quantized by Qdrant (MIT): search by meaning
//   rerank/  Jina reranker v1 turbo en, int8 (Apache-2.0): picks the best passages
// Every file is pinned to an exact version and checked against a SHA-256; files already there and
// correct are not downloaded again. They go to `models/` in the repository (not committed to git).
//
//   node scripts/fetch-models.mjs

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OCR = "https://github.com/GreatV/oar-ocr/releases/download/v0.7.0/";
const EMBED = "https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/aa8f8b060edb00e03bfdd08813a2949946c8ba55/";
const RERANK = "https://huggingface.co/jinaai/jina-reranker-v1-turbo-en/resolve/b8c14f4e723d9e0aab4732a7b7b93741eeeb77c2/";

// [saved as, url, sha256]
const FILES = [
  ["ocr/pp-ocrv6_small_det.onnx", OCR + "pp-ocrv6_small_det.onnx", "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e"],
  ["ocr/pp-ocrv6_small_rec.onnx", OCR + "pp-ocrv6_small_rec.onnx", "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634"],
  ["ocr/ppocrv6_dict.txt", OCR + "ppocrv6_dict.txt", "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d"],
  ["embed/model_optimized.onnx", EMBED + "model_optimized.onnx", "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431"],
  ["embed/tokenizer.json", EMBED + "tokenizer.json", "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66"],
  ["embed/config.json", EMBED + "config.json", "13582bcf2effc85b7bf3d3f5532e686bc1c9ce86bb009d10f0ec33cbe92299dd"],
  ["embed/special_tokens_map.json", EMBED + "special_tokens_map.json", "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a"],
  ["embed/tokenizer_config.json", EMBED + "tokenizer_config.json", "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53"],
  ["rerank/model_int8.onnx", RERANK + "onnx/model_int8.onnx", "3defdef1ae34e119bd704216087743e79665934c96aebabcb6077c239dc3ae66"],
  ["rerank/tokenizer.json", RERANK + "tokenizer.json", "0046da43cc8c424b317f56b092b0512aaaa65c4f925d2f16af9d9eeb4d0ef902"],
  ["rerank/config.json", RERANK + "config.json", "e050ff6a15ae9295e84882fa0e98051bd8754856cd5201395ebf00ce9f2d609b"],
  ["rerank/special_tokens_map.json", RERANK + "special_tokens_map.json", "06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f"],
  ["rerank/tokenizer_config.json", RERANK + "tokenizer_config.json", "d291c6652d96d56ffdbcf1ea19d9bae5ed79003f7648c627e725a619227ce8fa"],
];

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "models");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

for (const [name, url, hash] of FILES) {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && sha(readFileSync(path)) === hash) continue;
  process.stdout.write(`Downloading model file ${name}… `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== hash) throw new Error(`${name} didn't match its expected SHA-256; not using it`);
  writeFileSync(path + ".part", buf);
  renameSync(path + ".part", path);
  console.log("done");
}
