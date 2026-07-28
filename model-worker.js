// Roda o modelo de IA numa thread separada (Web Worker), pra thread principal
// (e o React) nunca travarem enquanto a IA tá gerando resposta.

let generatorPromise = null;
let libPromise = null;

function getLib() {
  if (!libPromise) {
    libPromise = import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/+esm");
  }
  return libPromise;
}

function getGenerator() {
  if (!generatorPromise) {
    generatorPromise = getLib().then((lib) =>
      lib.pipeline("text-generation", "HuggingFaceTB/SmolLM2-135M-Instruct", {
        dtype: "q4",
        progress_callback: (p) => {
          if (p?.status === "progress" && p.total) {
            self.postMessage({ type: "progress", progress: Math.min(99, Math.round((p.loaded / p.total) * 100)) });
          }
        },
      })
    );
  }
  return generatorPromise;
}

const stopFlags = new Map();

self.addEventListener("message", async (e) => {
  const msg = e.data || {};

  if (msg.type === "stop") {
    stopFlags.set(msg.requestId, true);
    return;
  }

  if (msg.type === "load") {
    try {
      await getGenerator();
      self.postMessage({ type: "ready" });
    } catch (err) {
      generatorPromise = null;
      self.postMessage({ type: "load-error", message: (err && err.message) || String(err) });
    }
    return;
  }

  if (msg.type === "generate") {
    const { requestId, chatMessages, options } = msg;
    let full = "";
    try {
      const [lib, generator] = await Promise.all([getLib(), getGenerator()]);
      self.postMessage({ type: "generating-start", requestId });
      const streamer = new lib.TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (piece) => {
          full += piece;
          self.postMessage({ type: "token", requestId, delta: piece });
          if (stopFlags.get(requestId)) throw new Error("NEXIA_STOPPED_BY_USER");
        },
      });
      await generator(chatMessages, { ...options, streamer });
      self.postMessage({ type: "result", requestId, text: full.trim() });
    } catch (err) {
      const stopped = stopFlags.get(requestId) || (err && err.message === "NEXIA_STOPPED_BY_USER");
      if (stopped) {
        self.postMessage({ type: "result", requestId, text: full.trim(), stopped: true });
      } else {
        self.postMessage({ type: "generate-error", requestId, message: (err && err.message) || String(err) });
      }
    } finally {
      stopFlags.delete(requestId);
    }
  }
});
