/**
 * Neural Controller Implementation
 * 
 * Uses an ONNX model (MPC-trained neural network) to compute control actions.
 * The controller uses a receding horizon approach with:
 * - Current state (temperatures)
 * - Reference trajectory (from background profile)
 * - Forecast trajectory (predicted future states)
 * - Historical states and actions (memory buffer)
 * 
 * This controller implements Model Predictive Control (MPC) via a trained neural network
 * that has learned to optimize control actions over a prediction horizon.
 */

import type {
  ControllerOutput, 
  NeuralControllerConfig, 
  NeuralControllerParams 
} from './types';

export class NeuralController {
  // ONNX Runtime session for the trained policy network
  private session: ort.InferenceSession;
  
  // MPC parameters from configuration
  private nHorizon: number;      // Prediction horizon in seconds (e.g., 30s)
  private dstep: number;         // Subsampling interval in seconds (e.g., 2s)
  private nPastStates: number;   // Number of historical states to track (e.g., 10)
  private nSamples: number;      // Number of future samples to predict (e.g., 15)
  
  // Input/output dimensions
  private inputDim: number;      // Total input dimension to neural network
  
  // History buffers for recurrent control
  // Past states: [T_b] for last n_past_states timesteps (NORMALIZED)
  private pastStatesBuffer: number[];
  
  // Past actions: [heat, fan] for last n_past_states timesteps
  // Shape: Array of [heat, fan] pairs
  private pastActionsBuffer: [number, number][];
  
  /**
   * Create a neural controller
   * 
   * @param onnxSession - ONNX Runtime inference session for the policy network
   * @param config - Controller configuration from metadata YAML
   * @param _simulator - Reference to RoasterSimulator (unused, kept for API compatibility)
   */
  constructor(
    onnxSession: ort.InferenceSession,
    config: NeuralControllerConfig,
    _simulator: any
  ) {
    this.session = onnxSession;
    
    // Extract MPC parameters from config
    this.nHorizon = config.mpc_parameters.n_horizon;
    this.dstep = config.mpc_parameters.dstep;
    this.nPastStates = config.mpc_parameters.n_past_states;
    this.nSamples = config.mpc_parameters.n_samples;
    
    // Extract input dimensions
    this.inputDim = config.policy_network.input_dim;
    
    // Initialize history buffers with zeros
    this.pastStatesBuffer = new Array(this.nPastStates).fill(0);
    this.pastActionsBuffer = new Array(this.nPastStates).fill(null).map(() => [0, 0] as [number, number]);
    
    console.log('NeuralController initialized:');
    console.log(`  Horizon: ${this.nHorizon}s, Subsample: ${this.dstep}s`);
    console.log(`  Past states: ${this.nPastStates}, Samples: ${this.nSamples}`);
    console.log(`  Input dimension: ${this.inputDim}`);
  }
  
  /**
   * Compute control actions for current timestep
   * 
   * The neural controller processes:
   * 1. Forecast error (difference between predicted and desired trajectory)
   * 2. Future reference points from the target profile
   * 3. Sampled forecast (predicted future states)
   * 4. Current state (all temperature readings)
   * 5. Past states (historical temperature buffer)
   * 6. Historical error (past deviations from setpoint)
   * 7. Past actions (historical control inputs)
   * 
   * All these inputs are normalized and concatenated into a single vector
   * that is fed to the trained neural network.
   * 
   * @param params - Controller input parameters
   * @returns Control actions {heat, fan} both in [0, 1]
   */
  async compute(params: NeuralControllerParams): Promise<ControllerOutput> {
    const { currentState, currentTime, getSetpoint, generateForecast } = params;
    
    // Scaling factor for temperatures (matches training data)
    // Temperatures in the dataset are normalized by dividing by 100
    const TEMP_SCALE = 100.0;
    
    // Extract T_b (latent bean temperature) from current state (index 1)
    // This is already NORMALIZED (divided by TEMP_SCALE)
    const currentTb = currentState[1];
    
    // === STEP 1: Get future reference points from profile ===
    // Sample the target profile at dstep intervals up to n_samples points
    // These are in °C and need to be NORMALIZED
    const futureRef: number[] = [];
    for (let i = 0; i < this.nSamples; i++) {
      const futureTime = currentTime + (i * this.dstep) / 60;  // Convert seconds to minutes
      const setpoint = getSetpoint(futureTime);  // Returns °C
      futureRef.push(setpoint / TEMP_SCALE);  // Normalize
    }
    
    // === STEP 2: Generate forecast ===
    // Predict what would happen if we hold current control inputs constant
    // This provides a baseline trajectory that the controller can improve upon
    const lastActions = this.pastActionsBuffer[this.pastActionsBuffer.length - 1];
    const forecast = await generateForecast(lastActions[0], lastActions[1]);
    
    // Sample forecast at dstep intervals to match reference points
    // Forecast returns °C, need to NORMALIZE
    const sampledForecast: number[] = [];
    for (let i = 0; i < this.nSamples && i < forecast.bean.length; i++) {
      // Sample at every dstep point (forecast uses simulator timestep, typically 1.5s)
      const idx = Math.min(Math.round(i * this.dstep / 1.5), forecast.bean.length - 1);
      sampledForecast.push(forecast.bean[idx] / TEMP_SCALE);  // Normalize
    }
    
    // Pad if forecast is shorter than expected
    while (sampledForecast.length < this.nSamples) {
      const lastValue = sampledForecast.length > 0 ? 
        sampledForecast[sampledForecast.length - 1] : 
        currentState[3];  // Use T_bm if no forecast yet
      sampledForecast.push(lastValue);
    }
    
    // === STEP 3: Calculate forecast error ===
    // This shows how far the predicted trajectory deviates from the target
    // Positive error means we're predicting too high, negative means too low
    const forecastError = sampledForecast.map((f, i) => f - futureRef[i]);
    
    // === STEP 4: Calculate historical error ===
    // Track past deviations from setpoint to help controller learn patterns
    const historicalError: number[] = [];
    for (let i = 0; i < this.nPastStates; i++) {
      const pastTime = currentTime - ((this.nPastStates - 1 - i) * 1.5) / 60;  // Assuming 1.5s timestep
      const pastRef = getSetpoint(pastTime);  // Returns °C
      const pastState = this.pastStatesBuffer[i];  // Already normalized
      historicalError.push(pastState - (pastRef / TEMP_SCALE));  // Normalize reference
    }
    
    // === STEP 5: Flatten past actions buffer ===
    // Convert array of [heat, fan] pairs into flat array
    const pastActionsFlat: number[] = [];
    for (let i = 0; i < this.nPastStates; i++) {
      pastActionsFlat.push(this.pastActionsBuffer[i][0]);  // heat
      pastActionsFlat.push(this.pastActionsBuffer[i][1]);  // fan
    }
    
    // === STEP 6: Construct controller input vector ===
    // Order must match training data exactly!
    // Total: 90 elements for default configuration
    const controllerInput = [
      ...forecastError,           // 15 elements: predicted deviation from target
      ...futureRef,               // 15 elements: target temperatures
      ...sampledForecast,         // 15 elements: predicted temperatures
      ...Array.from(currentState),// 5 elements: [T_r, T_b, T_air, T_bm, T_atm]
      ...this.pastStatesBuffer,   // 10 elements: historical T_b values
      ...historicalError,         // 10 elements: historical errors
      ...pastActionsFlat          // 20 elements: historical actions (10 timesteps × 2)
    ];
    
    // Verify input dimension matches expected
    if (controllerInput.length !== this.inputDim) {
      console.error(`Input dimension mismatch: ${controllerInput.length} != ${this.inputDim}`);
      console.error('Components:', {
        forecastError: forecastError.length,
        futureRef: futureRef.length,
        sampledForecast: sampledForecast.length,
        currentState: currentState.length,
        pastStates: this.pastStatesBuffer.length,
        historicalError: historicalError.length,
        pastActions: pastActionsFlat.length
      });
      throw new Error('Controller input dimension mismatch');
    }
    
    // === STEP 7: Run ONNX inference ===
    // Feed the input vector through the trained neural network
    const inputTensor = new ort.Tensor(
      'float32', 
      new Float32Array(controllerInput), 
      [1, this.inputDim]  // Batch size 1, input dimension
    );
    
    const outputs = await this.session.run({ controller_input: inputTensor });
    const actions = outputs.control_actions.data;  // [heat, fan]
    
    // === STEP 8: Update history buffers ===
    // Store current state and actions for next iteration
    this.updateBuffers(currentTb, [actions[0] as number, actions[1] as number]);
    
    // Return control actions, clamped to valid range [0, 1]
    return {
      heat: Math.max(0, Math.min(1, actions[0] as number)),
      fan: Math.max(0, Math.min(1, actions[1] as number))
    };
  }
  
  /**
   * Update history buffers with new data
   * 
   * Implements a sliding window: oldest data is removed, newest is added.
   * This maintains a fixed-size history buffer for the controller.
   * 
   * @param currentTb - Current T_b (latent bean temperature, NORMALIZED)
   * @param actions - Control actions [heat, fan]
   */
  private updateBuffers(currentTb: number, actions: [number, number]): void {
    // Remove oldest entries
    this.pastStatesBuffer.shift();
    this.pastActionsBuffer.shift();
    
    // Add newest entries
    this.pastStatesBuffer.push(currentTb);
    this.pastActionsBuffer.push([...actions] as [number, number]);
  }
  
  /**
   * Reset controller state
   * 
   * Call this when starting a new roast session.
   * Clears all history buffers to prevent previous roast data
   * from affecting the new roast.
   */
  reset(): void {
    // Reset history buffers to zeros
    this.pastStatesBuffer = new Array(this.nPastStates).fill(0);
    this.pastActionsBuffer = new Array(this.nPastStates).fill(null).map(() => [0, 0] as [number, number]);
    
    console.log('NeuralController reset');
  }
}
