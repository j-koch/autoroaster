/**
 * Controller Types and Interfaces
 * 
 * Defines TypeScript interfaces for all controller implementations.
 * These types ensure type safety across the control system.
 */

/**
 * PID Controller Gains
 * 
 * Proportional-Integral-Derivative gains for PID control.
 * - Kp: Proportional gain - responds to current error
 * - Ki: Integral gain - responds to accumulated error over time
 * - Kd: Derivative gain - responds to rate of change of error
 */
export interface PIDGains {
  Kp: number;
  Ki: number;
  Kd: number;
}

/**
 * PID Controller Diagnostics
 * 
 * Provides detailed information about PID controller state for tuning and debugging.
 */
export interface PIDDiagnostics {
  /** Proportional term contribution */
  P: number;
  /** Integral term contribution */
  I: number;
  /** Derivative term contribution */
  D: number;
  /** Total output value */
  output: number;
  /** Current integral accumulator value */
  integral: number;
}

/**
 * Controller Output
 * 
 * Standard output format for all controllers.
 * Values are normalized to [0, 1] range.
 */
export interface ControllerOutput {
  /** Heater power (0-1) */
  heat: number;
  /** Fan speed (0-1) */
  fan: number;
}

/**
 * Controller Interface
 * 
 * All controllers must implement this interface to ensure consistent API.
 */
export interface IController {
  /**
   * Compute control output for current timestep
   * 
   * @param setpoint - Desired value (target temperature in °C)
   * @param measurement - Current measured value (current temperature in °C)
   * @param currentTime - Current time in seconds
   * @returns Control output(s)
   */
  compute(setpoint: number, measurement: number, currentTime: number): number | ControllerOutput;
  
  /**
   * Reset controller state
   * Call this when starting a new control session
   */
  reset(): void;
}

/**
 * Neural Controller Configuration
 * 
 * Configuration parameters loaded from controller metadata YAML file.
 */
export interface NeuralControllerConfig {
  /** MPC parameters */
  mpc_parameters: {
    /** Prediction horizon in seconds */
    n_horizon: number;
    /** Subsampling interval in seconds */
    dstep: number;
    /** Number of past states to track */
    n_past_states: number;
    /** Number of future samples to predict */
    n_samples: number;
  };
  
  /** Policy network architecture */
  policy_network: {
    /** Total input dimension */
    input_dim: number;
    /** Breakdown of input components */
    input_breakdown: {
      forecast_error: number;
      future_ref: number;
      sampled_forecast: number;
      current_state: number;
      past_states: number;
      historical_error: number;
      past_actions: number;
    };
  };
}

/**
 * Neural Controller Compute Parameters
 * 
 * Parameters passed to neural controller compute method.
 */
export interface NeuralControllerParams {
  /** Current latent state [T_r, T_b, T_air, T_bm, T_atm] (NORMALIZED) */
  currentState: Float32Array;
  /** Current time in minutes */
  currentTime: number;
  /** Function to get setpoint at a given time (returns °C) */
  getSetpoint: (time: number) => number;
  /** Function to generate forecast (returns °C) */
  generateForecast: (heat: number, fan: number) => Promise<ForecastData>;
}

/**
 * Forecast Data Structure
 * 
 * Contains temperature predictions over time.
 */
export interface ForecastData {
  /** Time points in minutes */
  time: number[];
  /** Predicted bean temperatures (°C) */
  bean: number[];
  /** Predicted environment temperatures (°C) */
  environment: number[];
  /** Predicted roaster temperatures (°C) */
  roaster: number[];
  /** Predicted air temperatures (°C) */
  air: number[];
  /** Predicted rate of rise (°C/min) */
  rateOfRise: number[];
}
