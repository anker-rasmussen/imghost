// KTX2 (Basis UASTC) textures without loosening the CSP.
// three's KTX2Loader transcodes in a Worker started from a blob: URL (needs `worker-src blob:`). A same-origin worker
// file would avoid blob:, but Firefox refuses the transcoder's WebAssembly.instantiate inside workers under
// 'wasm-unsafe-eval' (it would need 'unsafe-eval'). So the identical transcoder code runs in the page instead, as a
// Worker-shaped object (vendor/.../ktx2_inline.js, built by tools/showroom/build_ktx2_worker.mjs): no workers, no
// blob:, no eval; the WebAssembly compile is covered by the page's existing 'wasm-unsafe-eval'.
import { FileLoader } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { createInlineTranscoder } from '../vendor/three/addons/libs/basis/ktx2_inline.js?v=1eac0796c0b9c11a';

const WASM = new URL('../vendor/three/addons/libs/basis/basis_transcoder.wasm?v=6cf17dc889352c42', import.meta.url).href;

export class SafeKTX2Loader extends KTX2Loader {
  init() {
    if (!this.transcoderPending) {
      const bin = new FileLoader(this.manager);
      bin.setResponseType('arraybuffer');
      this.transcoderPending = bin.loadAsync(WASM).then((binary) => {
        this.transcoderBinary = binary;
        this.workerPool.setWorkerCreator(() => {
          const t = createInlineTranscoder();
          const transcoderBinary = this.transcoderBinary.slice(0);
          t.postMessage({ type: 'init', config: this.workerConfig, transcoderBinary });
          return t;
        });
      });
    }
    return this.transcoderPending;
  }
}
