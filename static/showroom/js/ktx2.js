// KTX2 (Basis UASTC) textures, transcoded off the main thread, without loosening the CSP.
// three's KTX2Loader assembles its worker at runtime and starts it from a blob: URL (needs `worker-src blob:`);
// this subclass starts the identical worker from a static same-origin file instead (built by
// tools/showroom/build_ktx2_worker.mjs), so `worker-src` stays covered by script-src 'self'.
import { FileLoader } from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const WORKER = new URL('../vendor/three/addons/libs/basis/ktx2_worker.js?v=6129d96ed5369568', import.meta.url).href;
const WASM = new URL('../vendor/three/addons/libs/basis/basis_transcoder.wasm?v=6cf17dc889352c42', import.meta.url).href;

export class SafeKTX2Loader extends KTX2Loader {
  init() {
    if (!this.transcoderPending) {
      const bin = new FileLoader(this.manager);
      bin.setResponseType('arraybuffer');
      this.transcoderPending = bin.loadAsync(WASM).then((binary) => {
        this.transcoderBinary = binary;
        this.workerPool.setWorkerCreator(() => {
          const worker = new Worker(WORKER);
          const transcoderBinary = this.transcoderBinary.slice(0);
          worker.postMessage({ type: 'init', config: this.workerConfig, transcoderBinary }, [transcoderBinary]);
          return worker;
        });
      });
    }
    return this.transcoderPending;
  }
}
