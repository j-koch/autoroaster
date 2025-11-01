/**
 * PID Controller Implementation
 * 
 * A classic PID (Proportional-Integral-Derivative) controller for temperature tracking.
 * 
 * The controller computes control actions based on three terms:
 * - P (Proportional): Error between setpoint and measurement
 * - I (Integral): Accumulated error over time  
 * - D (Derivative): Rate of change of error
 * 
 * Control output = Kp*error + Ki*integral + Kd*derivative
 * 
 * Features:
 * - Output clamping to prevent saturation
 * - Anti-windup protection for integral term
 * - Diagnostic information for tuning
 */

import type { PIDGains, PIDDiagnostics, IController } from './types';

export class PIDController implements IController {
  // PID gains - control how strongly each term affects the output
  private Kp: number;  // Proportional gain
  private Ki: number;  // Integral gain
  private Kd: number;  // Derivative gain
  
  // Output limits - prevents controller from requesting impossible values
  private outputMin: number;
  private outputMax: number;
  
  // Integral limits - prevents integral windup where accumulated error grows unbounded
  private integralMin: number;
  private integralMax: number;
  
  // Internal state - tracks controller history for derivative and integral calculations
  private integral: number;        // Accumulated error over time
  private previousError: number;   // Error from last timestep (for derivative calculation)
  private previousTime: number | null;  // Time of last update (for dt calculation)
  
  // Diagnostics - stores last computed values for debugging and tuning
  private lastP: number;      // Last proportional term value
  private lastI: number;      // Last integral term value
  private lastD: number;      // Last derivative term value
  private lastOutput: number; // Last control output value
  
  /**
   * Create a PID controller
   * 
   * @param Kp - Proportional gain (default: 0.01)
   * @param Ki - Integral gain (default: 0.001)
   * @param Kd - Derivative gain (default: 0.005)
   * @param outputMin - Minimum output value (default: 0.0)
   * @param outputMax - Maximum output value (default: 1.0)
   * @param integralMin - Minimum integral term for anti-windup (default: -1.0)
   * @param integralMax - Maximum integral term for anti-windup (default: 1.0)
   */
  constructor(
    Kp: number = 0.01,
    Ki: number = 0.001,
    Kd: number = 0.005,
    outputMin: number = 0.0,
    outputMax: number = 1.0,
    integralMin: number = -1.0,
    integralMax: number = 1.0
  ) {
    this.Kp = Kp;
    this.Ki = Ki;
    this.Kd = Kd;
    
    this.outputMin = outputMin;
    this.outputMax = outputMax;
    
    this.integralMin = integralMin;
    this.integralMax = integralMax;
    
    // Initialize state to zero
    this.integral = 0.0;
    this.previousError = 0.0;
    this.previousTime = null;
    
    // Initialize diagnostics
    this.lastP = 0.0;
    this.lastI = 0.0;
    this.lastD = 0.0;
    this.lastOutput = 0.0;
  }
  
  /**
   * Compute control output for current timestep
   * 
   * This is the main PID algorithm:
   * 1. Calculate error (setpoint - measurement)
   * 2. Calculate P term (proportional to error)
   * 3. Update integral (accumulated error) and calculate I term
   * 4. Calculate derivative (rate of error change) and D term
   * 5. Sum all terms and clamp to valid output range
   * 
   * @param setpoint - Desired value (target temperature in °C)
   * @param measurement - Current measured value (current temperature in °C)
   * @param currentTime - Current time in seconds
   * @returns Control output clamped to [outputMin, outputMax]
   */
  compute(setpoint: number, measurement: number, currentTime: number): number {
    // Calculate error (positive when below setpoint, negative when above)
    const error = setpoint - measurement;
    
    // Calculate time delta (dt) between this update and the last
    let dt = 1.0;  // Default to 1 second if this is the first call
    if (this.previousTime !== null) {
      dt = currentTime - this.previousTime;
      // Prevent division by zero or negative dt (e.g. if time goes backwards)
      if (dt <= 0) {
        dt = 1.0;
      }
    }
    
    // === PROPORTIONAL TERM ===
    // Responds to current error magnitude
    // Larger Kp → stronger immediate response to error
    const P = this.Kp * error;
    
    // === INTEGRAL TERM ===
    // Responds to accumulated error over time
    // Helps eliminate steady-state error
    // Larger Ki → faster elimination of persistent errors
    this.integral += error * dt;
    
    // Anti-windup: clamp integral to prevent excessive accumulation
    // Without this, integral can grow unbounded during saturation
    this.integral = Math.max(this.integralMin, Math.min(this.integralMax, this.integral));
    const I = this.Ki * this.integral;
    
    // === DERIVATIVE TERM ===
    // Responds to rate of change of error
    // Provides damping to prevent overshoot
    // Larger Kd → more damping, slower response
    const derivative = (error - this.previousError) / dt;
    const D = this.Kd * derivative;
    
    // === COMPUTE TOTAL OUTPUT ===
    // Sum all three terms
    let output = P + I + D;
    
    // Clamp output to valid range [outputMin, outputMax]
    // This prevents requesting impossible control values (e.g. negative heater power)
    output = Math.max(this.outputMin, Math.min(this.outputMax, output));
    
    // Store state for next iteration
    this.previousError = error;
    this.previousTime = currentTime;
    
    // Store diagnostics for tuning/debugging
    this.lastP = P;
    this.lastI = I;
    this.lastD = D;
    this.lastOutput = output;
    
    return output;
  }
  
  /**
   * Reset controller state
   * 
   * Call this when:
   * - Starting a new control session
   * - Changing setpoint significantly
   * - After a long period of inactivity
   * 
   * This prevents accumulated state from affecting the new session
   */
  reset(): void {
    this.integral = 0.0;
    this.previousError = 0.0;
    this.previousTime = null;
    this.lastP = 0.0;
    this.lastI = 0.0;
    this.lastD = 0.0;
    this.lastOutput = 0.0;
  }
  
  /**
   * Update PID gains
   * 
   * Allows online tuning without recreating the controller.
   * Useful for adaptive control or manual tuning during operation.
   * 
   * @param Kp - New proportional gain (or null to keep current)
   * @param Ki - New integral gain (or null to keep current)
   * @param Kd - New derivative gain (or null to keep current)
   */
  setGains(Kp: number | null, Ki: number | null, Kd: number | null): void {
    if (Kp !== null) this.Kp = Kp;
    if (Ki !== null) this.Ki = Ki;
    if (Kd !== null) this.Kd = Kd;
  }
  
  /**
   * Get current PID gains
   * 
   * @returns Current gains {Kp, Ki, Kd}
   */
  getGains(): PIDGains {
    return {
      Kp: this.Kp,
      Ki: this.Ki,
      Kd: this.Kd
    };
  }
  
  /**
   * Get diagnostic information for tuning
   * 
   * Provides insight into controller behavior:
   * - If P dominates: Controller is responding to current error
   * - If I dominates: Controller is fighting steady-state error
   * - If D dominates: Controller is dampening rapid changes
   * 
   * @returns Diagnostic data showing contribution of each term
   */
  getDiagnostics(): PIDDiagnostics {
    return {
      P: this.lastP,
      I: this.lastI,
      D: this.lastD,
      output: this.lastOutput,
      integral: this.integral
    };
  }
}
