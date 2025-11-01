/**
 * Simulator Types and Interfaces
 * 
 * Defines TypeScript interfaces for the coffee roaster simulator.
 * These types ensure type safety across the simulation system.
 */

/**
 * Roasting Phase
 * 
 * Represents the current state of the roasting process.
 */
export type RoastPhase = 'idle' | 'charging' | 'roasting' | 'dropped';

/**
 * Control Mode
 * 
 * Specifies which controller is active.
 */
export type ControlMode = 'manual' | 'pid' | 'neural';

/**
 * Simulator State
 * 
 * Complete state of the roaster simulator at a given timestep.
 * State vector: [T_r, T_b, T_air, T_bm, T_atm]
 * All temperatures are NORMALIZED (divided by scaling factor).
 */
export interface SimulatorState {
  /** Roaster drum temperature (normalized) */
  T_r: number;
  /** Bean core temperature (normalized) */
  T_b: number;
  /** Air temperature in chamber (normalized) */
  T_air: number;
  /** Bean probe measurement (normalized) */
  T_bm: number;
  /** Environment probe measurement (normalized) */
  T_atm: number;
}

/**
 * Control Inputs
 * 
 * User-adjustable control parameters.
 * All control values are normalized to [0, 1] range.
 */
export interface ControlInputs {
  /** Heater power (0-1) */
  heater: number;
  /** Fan speed (0-1) */
  fan: number;
  /** Bean mass in grams */
  mass: number;
}

/**
 * Fixed Parameters
 * 
 * Environmental and equipment parameters that remain constant.
 */
export interface FixedParameters {
  /** Drum rotation speed (0-1, typically 0.6) */
  drum: number;
  /** Ambient temperature in °C */
  ambient: number;
  /** Relative humidity (0-1) */
  humidity: number;
}

/**
 * Scaling Factors
 * 
 * Normalization factors matching dataset.py SCALING_FACTORS.
 * Used to convert between physical units and normalized values.
 */
export interface ScalingFactors {
  /** Temperature scaling factors */
  temperatures: {
    /** Bean and environment temps (typical max ~250°C) */
    bean: number;
    /** Environment temperature */
    environment: number;
    /** Temperature difference (BT - ET) */
    temp_difference: number;
  };
  /** Control input scaling factors */
  controls: {
    /** Heater power percentage */
    heater: number;
    /** Fan speed percentage */
    fan: number;
    /** Drum speed percentage */
    drum: number;
    /** Ambient temperature in °C */
    ambient: number;
    /** Humidity percentage */
    humidity: number;
  };
  /** Mass scaling (typical batch ~100g) */
  mass: number;
  /** Time scaling (converts seconds to minutes) */
  time: number;
}

/**
 * ONNX Model Sessions
 * 
 * Collection of loaded ONNX Runtime inference sessions.
 */
export interface ONNXSessions {
  /** State estimator model (if used) */
  stateEstimator: any | null;
  /** Roast stepper model - predicts next state */
  roastStepper: any;
  /** Bean thermal model - predicts bean thermal capacity */
  beanModel: any;
}

/**
 * Simulation Data
 * 
 * Time series data collected during simulation.
 */
export interface SimulationData {
  /** Time points in minutes */
  time: number[];
  /** Temperature measurements */
  temperature: {
    /** Bean probe temperatures (°C) */
    bean: number[];
    /** Bean surface temperatures (°C) */
    environment: number[];
    /** Roaster drum temperatures (°C) */
    roaster: number[];
    /** Air temperatures (°C) */
    air: number[];
    /** Measured air temperatures (°C) */
    airMeasured: number[];
  };
  /** Control inputs over time */
  control: {
    /** Heater power (0-1) */
    heater: number[];
    /** Fan speed (0-1) */
    fan: number[];
    /** Drum speed (0-1) */
    drum: number[];
  };
  /** Rate of rise (°C/min) */
  rateOfRise: number[];
}

/**
 * Forecast Result
 * 
 * Predicted future trajectory from current state.
 */
export interface ForecastResult {
  /** Time points for forecast (minutes) */
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

/**
 * Background Profile
 * 
 * Reference temperature trajectory for controller tracking.
 */
export interface BackgroundProfile {
  /** Time points in minutes */
  times: number[];
  /** Target temperatures in °C */
  temps: number[];
  /** Profile metadata */
  metadata: ProfileMetadata;
}

/**
 * Profile Metadata
 * 
 * Information about a temperature profile.
 */
export interface ProfileMetadata {
  /** Profile name */
  name: string;
  /** Profile description */
  description: string;
  /** Total duration in minutes */
  duration: number;
  /** Starting temperature (°C) */
  startTemp: number;
  /** Maximum temperature (°C) */
  maxTemp: number;
  /** Final temperature (°C) */
  finalTemp: number;
  /** Maximum rate of rise (°C/min) */
  maxRateOfRise: number;
  /** Number of segments or waypoints */
  nSegments?: number;
  /** Generation timestamp */
  generated: string;
}

/**
 * Simulator Configuration
 * 
 * Configuration options for the RoasterSimulator.
 */
export interface SimulatorConfig {
  /** Physics timestep in seconds */
  timestep: number;
  /** Simulation speedup factor (1x = realtime) */
  speedupFactor: number;
  /** Preheat temperature in °C */
  preheatTemp: number;
  /** Default control inputs */
  defaultControls: ControlInputs;
  /** Fixed environmental parameters */
  fixedParams: FixedParameters;
}

/**
 * Slider Elements
 * 
 * DOM element references for UI controls.
 */
export interface SliderElements {
  /** Mass slider input */
  mass: HTMLInputElement;
  /** Mass value display */
  massValue: HTMLElement;
  /** Mass status indicator */
  massStatus: HTMLElement;
}
