/**
 * Global type declarations for ONNX Runtime Web loaded from CDN
 * 
 * This file declares the global `ort` object that is created when loading
 * ONNX Runtime Web via CDN script tag in HTML files.
 * 
 * The CDN script creates a global variable `ort` which provides all the
 * ONNX Runtime Web functionality without needing npm imports.
 */

import type * as OnnxRuntime from 'onnxruntime-web';

declare global {
  /**
   * ONNX Runtime Web namespace - loaded from CDN
   * Available globally after the script tag loads
   * 
   * This provides the same API as the npm package, but loaded from CDN.
   */
  const ort: typeof OnnxRuntime;
  
  /**
   * Make ort available as a namespace as well for compatibility
   */
  namespace ort {
    type InferenceSession = OnnxRuntime.InferenceSession;
    type Tensor = OnnxRuntime.Tensor;
    type Env = OnnxRuntime.Env;
  }
}

export {};
