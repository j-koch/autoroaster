/**
 * Profile Generator Module
 * 
 * Generates randomized roast profiles based on control_utils.py logic.
 * Provides profile storage, editing, and management capabilities.
 */

class ProfileGenerator {
    /**
     * Generate a piecewise linear reference trajectory for bean temperature.
     * Based on control_utils.py generate_reference_trajectory()
     * 
     * Temperature scaling: T[°C] = T[normalized] * 100
     * e.g., 0.2 = 20°C, 1.0 = 100°C, 2.5 = 250°C
     * 
     * The trajectory consists of 5-10 linear segments with:
     * - Random number of segments (5-10)
     * - Random starting temperature (15-35°C)
     * - Each segment has random slope (0.0 to 0.3 normalized °C/min, sorted descending)
     * - Segments are continuous (end of one connects to start of next)
     * - Equal time duration for each segment
     * - Full profile clipped to physical range (15-250°C)
     * 
     * @param {Array<number>} times - Time points in minutes
     * @returns {Object} - {times: Array, temps: Array, metadata: Object}
     */
    static generateRandomProfile(times) {
        // Number of segments for the development phase (4 to 9, after initial drying)
        const nDevelopmentSegments = Math.floor(Math.random() * 6) + 4;
        const nSegments = nDevelopmentSegments + 1; // +1 for the fixed drying segment
        
        // Fixed starting temperature: room temperature (24°C, normalized 0.24)
        const roomTempNormalized = 0.24;
        
        // Fixed drying phase: goes from 24°C to 100°C in first ~1 minute
        const dryingEndTempNormalized = 1.0; // 100°C
        const dryingDuration = 1.0; // 1 minute
        
        // Generate slopes for development segments (0.0 to 0.3 normalized °C/min)
        // Sort in descending order (start high, decrease over time - typical roast profile)
        const developmentSlopes = [];
        for (let i = 0; i < nDevelopmentSegments; i++) {
            developmentSlopes.push(Math.random() * 0.2);
        }
        developmentSlopes.sort((a, b) => b - a);  // Sort descending
        
        // Calculate segment boundaries
        const tMin = times[0];
        const tMax = times[times.length - 1];
        
        // Remaining time after drying phase
        const remainingDuration = tMax - tMin - dryingDuration;
        const developmentSegmentDuration = remainingDuration / nDevelopmentSegments;
        
        // Calculate fixed drying slope: (100°C - 24°C) / 1 minute = 76°C/min normalized = 0.76
        const dryingSlope = (dryingEndTempNormalized - roomTempNormalized) / dryingDuration;
        
        // Combine drying slope with development slopes
        const slopes = [dryingSlope, ...developmentSlopes];
        
        // Generate profile (working in normalized units)
        const profileNormalized = [];
        
        // Track segment boundaries and starting temperatures
        const segmentStartTemps = [roomTempNormalized];
        const segmentDurations = [dryingDuration];
        
        // Add development segment durations
        for (let i = 0; i < nDevelopmentSegments; i++) {
            segmentDurations.push(developmentSegmentDuration);
        }
        
        // Pre-calculate where each segment starts and its initial temperature
        for (let seg = 0; seg < nSegments; seg++) {
            const segDuration = segmentDurations[seg];
            const endTemp = segmentStartTemps[seg] + slopes[seg] * segDuration;
            
            // This ending temperature becomes the starting temperature of the next segment
            if (seg < nSegments - 1) {
                segmentStartTemps.push(endTemp);
            }
        }
        
        // Calculate cumulative time points for segment boundaries
        const segmentStartTimes = [tMin];
        for (let seg = 0; seg < nSegments; seg++) {
            segmentStartTimes.push(segmentStartTimes[seg] + segmentDurations[seg]);
        }
        
        // Now generate the profile with continuous segments
        for (let i = 0; i < times.length; i++) {
            const t = times[i];
            
            // Determine which segment we're in by finding the last segment start time <= t
            let segmentIdx = 0;
            for (let seg = 0; seg < nSegments; seg++) {
                if (t >= segmentStartTimes[seg]) {
                    segmentIdx = seg;
                } else {
                    break;
                }
            }
            
            // Get the starting temperature and time for this segment
            const segmentStartTemp = segmentStartTemps[segmentIdx];
            const segmentStartTime = segmentStartTimes[segmentIdx];
            
            // Linear temperature for this segment: T = T_start + slope * (t - t_start)
            const temp = segmentStartTemp + slopes[segmentIdx] * (t - segmentStartTime);
            
            // Clip to physical bounds (20-250°C → 0.2-2.5 normalized)
            const clippedTemp = Math.max(0.2, Math.min(2.5, temp));
            profileNormalized.push(clippedTemp);
        }
        
        // Denormalize to °C for display
        const profileCelsius = profileNormalized.map(t => t * 100);
        
        // Calculate metadata
        const maxTemp = Math.max(...profileCelsius);
        const finalTemp = profileCelsius[profileCelsius.length - 1];
        const duration = tMax - tMin;
        
        // Calculate maximum rate of rise (°C/min)
        let maxRateOfRise = 0;
        for (let i = 1; i < profileCelsius.length; i++) {
            const dt = times[i] - times[i-1];
            if (dt > 0) {
                const dT = profileCelsius[i] - profileCelsius[i-1];
                const ror = dT / dt;
                maxRateOfRise = Math.max(maxRateOfRise, ror);
            }
        }
        
        return {
            times: times,
            temps: profileCelsius,
            metadata: {
                name: `Random Profile ${new Date().toLocaleTimeString()}`,
                description: 'Auto-generated randomized roast profile',
                duration: duration,
                startTemp: profileCelsius[0],
                maxTemp: maxTemp,
                finalTemp: finalTemp,
                maxRateOfRise: maxRateOfRise,
                nSegments: nSegments,
                generated: new Date().toISOString()
            }
        };
    }
    
    /**
     * Generate the default roast profile using predefined waypoints
     * 
     * Default waypoints (time in minutes, temp normalized):
     * - 0.0 min: 0.24 (24°C) - Room temperature start
     * - 0.5 min: 1.0 (100°C) - End of drying phase
     * - 5.0 min: 1.6 (160°C) - Mid-development
     * - 10.0 min: 2.03 (203°C) - Final temperature
     * 
     * @param {Array<number>} times - Time points in minutes for interpolation
     * @returns {Object} - {times: Array, temps: Array, metadata: Object}
     */
    static generateDefaultProfile(times) {
        // Define the default waypoints (time, temperature_normalized)
        const waypoints = [
            { time: 0.0, temp: 0.24 },   // 24°C - Room temperature
            { time: 0.5, temp: 1.0 },    // 100°C - End of drying
            { time: 5.0, temp: 1.7 },    // 160°C - Mid-development
            { time: 10.0, temp: 2.03 }   // 203°C - Final temperature
        ];
        
        // Interpolate temperatures at all requested time points
        const tempsNormalized = times.map(t => {
            // Find the surrounding waypoints for time t
            let i = 0;
            while (i < waypoints.length - 1 && waypoints[i + 1].time <= t) {
                i++;
            }
            
            // If we're past the last waypoint, hold the final temperature constant
            if (i === waypoints.length - 1) {
                return waypoints[i].temp;
            }
            
            // If we're before the first waypoint, hold the initial temperature constant
            if (t <= waypoints[0].time) {
                return waypoints[0].temp;
            }
            
            // Linear interpolation between waypoints[i] and waypoints[i+1]
            const t1 = waypoints[i].time;
            const t2 = waypoints[i + 1].time;
            const T1 = waypoints[i].temp;
            const T2 = waypoints[i + 1].temp;
            
            // Fraction of the way between the two waypoints
            const fraction = (t - t1) / (t2 - t1);
            
            // Interpolated temperature (normalized)
            return T1 + fraction * (T2 - T1);
        });
        
        // Convert from normalized to Celsius (multiply by 100)
        const tempsCelsius = tempsNormalized.map(t => t * 100);
        
        // Calculate metadata
        const maxTemp = Math.max(...tempsCelsius);
        const finalTemp = tempsCelsius[tempsCelsius.length - 1];
        const duration = times[times.length - 1] - times[0];
        
        // Calculate maximum rate of rise (°C/min)
        let maxRateOfRise = 0;
        for (let i = 1; i < tempsCelsius.length; i++) {
            const dt = times[i] - times[i-1];
            if (dt > 0) {
                const dT = tempsCelsius[i] - tempsCelsius[i-1];
                const ror = dT / dt;
                maxRateOfRise = Math.max(maxRateOfRise, ror);
            }
        }
        
        return {
            times: times,
            temps: tempsCelsius,
            metadata: {
                name: 'Default Roast Profile',
                description: 'Standard roast profile: 24°C → 100°C (0.5min) → 160°C (5min) → 203°C (10min)',
                duration: duration,
                startTemp: tempsCelsius[0],
                maxTemp: maxTemp,
                finalTemp: finalTemp,
                maxRateOfRise: maxRateOfRise,
                waypoints: waypoints.length,
                generated: new Date().toISOString()
            }
        };
    }
    
    /**
     * Generate a template profile for common roast styles
     * 
     * @param {string} style - 'light', 'medium', or 'dark'
     * @param {number} duration - Total duration in minutes (default 10)
     * @returns {Object} - {times: Array, temps: Array, metadata: Object}
     */
    static generateTemplateProfile(style = 'medium', duration = 10) {
        const nPoints = Math.floor(duration * 60);  // One point per second
        const times = [];
        for (let i = 0; i <= nPoints; i++) {
            times.push((i / 60));  // Convert to minutes
        }
        
        let profile;
        
        switch (style.toLowerCase()) {
            case 'light':
                // Light roast: gentler heating, lower final temp (210°C)
                profile = this.generateLinearRampProfile(times, 25, 210, 8);
                profile.metadata.name = 'Light Roast Template';
                profile.metadata.description = 'Gentle heating to 210°C, preserves origin characteristics';
                break;
                
            case 'dark':
                // Dark roast: aggressive heating, higher final temp (230°C)
                profile = this.generateLinearRampProfile(times, 25, 230, 12);
                profile.metadata.name = 'Dark Roast Template';
                profile.metadata.description = 'Aggressive heating to 230°C, bold flavors';
                break;
                
            case 'medium':
            default:
                // Medium roast: balanced heating to 220°C
                profile = this.generateLinearRampProfile(times, 25, 220, 10);
                profile.metadata.name = 'Medium Roast Template';
                profile.metadata.description = 'Balanced heating to 220°C, classic profile';
                break;
        }
        
        return profile;
    }
    
    /**
     * Generate a simple linear ramp profile
     * 
     * @param {Array<number>} times - Time points in minutes
     * @param {number} startTemp - Starting temperature in °C
     * @param {number} endTemp - Ending temperature in °C
     * @param {number} totalDuration - Total duration in minutes
     * @returns {Object} - {times: Array, temps: Array, metadata: Object}
     */
    static generateLinearRampProfile(times, startTemp, endTemp, totalDuration) {
        const temps = times.map(t => {
            if (t > totalDuration) {
                return endTemp;
            }
            return startTemp + (endTemp - startTemp) * (t / totalDuration);
        });
        
        return {
            times: times,
            temps: temps,
            metadata: {
                name: 'Linear Ramp',
                description: `Linear ramp from ${startTemp}°C to ${endTemp}°C`,
                duration: totalDuration,
                startTemp: startTemp,
                maxTemp: endTemp,
                finalTemp: endTemp,
                maxRateOfRise: (endTemp - startTemp) / totalDuration,
                generated: new Date().toISOString()
            }
        };
    }
}


/**
 * Profile Library - handles storage and retrieval of profiles
 */
class ProfileLibrary {
    constructor() {
        this.storageKey = 'autoroaster_profiles';
    }
    
    /**
     * Save a profile to localStorage
     * 
     * @param {Object} profile - Profile object with times, temps, metadata
     * @returns {boolean} - Success status
     */
    saveProfile(profile) {
        try {
            const profiles = this.loadAllProfiles();
            
            // Generate unique ID if not present
            if (!profile.metadata.id) {
                profile.metadata.id = Date.now().toString();
            }
            
            // Add or update profile
            const existingIndex = profiles.findIndex(p => p.metadata.id === profile.metadata.id);
            if (existingIndex >= 0) {
                profiles[existingIndex] = profile;
            } else {
                profiles.push(profile);
            }
            
            localStorage.setItem(this.storageKey, JSON.stringify(profiles));
            return true;
        } catch (error) {
            console.error('Error saving profile:', error);
            return false;
        }
    }
    
    /**
     * Load all saved profiles from localStorage
     * 
     * @returns {Array<Object>} - Array of profile objects
     */
    loadAllProfiles() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.error('Error loading profiles:', error);
            return [];
        }
    }
    
    /**
     * Load a specific profile by ID
     * 
     * @param {string} id - Profile ID
     * @returns {Object|null} - Profile object or null if not found
     */
    loadProfile(id) {
        const profiles = this.loadAllProfiles();
        return profiles.find(p => p.metadata.id === id) || null;
    }
    
    /**
     * Delete a profile by ID
     * 
     * @param {string} id - Profile ID
     * @returns {boolean} - Success status
     */
    deleteProfile(id) {
        try {
            const profiles = this.loadAllProfiles();
            const filtered = profiles.filter(p => p.metadata.id !== id);
            localStorage.setItem(this.storageKey, JSON.stringify(filtered));
            return true;
        } catch (error) {
            console.error('Error deleting profile:', error);
            return false;
        }
    }
    
    /**
     * Export a profile as JSON string
     * 
     * @param {Object} profile - Profile object
     * @returns {string} - JSON string
     */
    exportProfile(profile) {
        return JSON.stringify(profile, null, 2);
    }
    
    /**
     * Import a profile from JSON string
     * 
     * @param {string} jsonString - JSON string
     * @returns {Object|null} - Profile object or null if invalid
     */
    importProfile(jsonString) {
        try {
            const profile = JSON.parse(jsonString);
            
            // Validate profile structure
            if (!profile.times || !profile.temps || !profile.metadata) {
                throw new Error('Invalid profile structure');
            }
            
            // Generate new ID to avoid conflicts
            profile.metadata.id = Date.now().toString();
            profile.metadata.imported = new Date().toISOString();
            
            return profile;
        } catch (error) {
            console.error('Error importing profile:', error);
            return null;
        }
    }
}


/**
 * Profile Designer - interactive profile editing
 * This will be expanded in future phases with full waypoint editing UI
 */
class ProfileDesigner {
    constructor(containerElement) {
        this.container = containerElement;
        this.currentProfile = null;
        this.waypoints = [];  // Array of {time: number, temp: number}
    }
    
    /**
     * Load a profile for editing
     * 
     * @param {Object} profile - Profile object
     */
    loadProfile(profile) {
        this.currentProfile = profile;
        
        // Extract waypoints from profile (sample every minute)
        this.waypoints = [];
        for (let i = 0; i < profile.times.length; i += 60) {  // Every 60 seconds
            this.waypoints.push({
                time: profile.times[i],
                temp: profile.temps[i]
            });
        }
    }
    
    /**
     * Regenerate profile from waypoints using interpolation
     * 
     * @param {Array<number>} times - Time points for output
     * @returns {Object} - Profile object
     */
    generateFromWaypoints(times) {
        if (this.waypoints.length < 2) {
            throw new Error('Need at least 2 waypoints to generate profile');
        }
        
        // Sort waypoints by time
        this.waypoints.sort((a, b) => a.time - b.time);
        
        // Linear interpolation between waypoints
        const temps = times.map(t => {
            // Find surrounding waypoints
            let i = 0;
            while (i < this.waypoints.length - 1 && this.waypoints[i + 1].time < t) {
                i++;
            }
            
            if (i === this.waypoints.length - 1) {
                // Past last waypoint, hold constant
                return this.waypoints[i].temp;
            }
            
            // Linear interpolation between waypoints[i] and waypoints[i+1]
            const t1 = this.waypoints[i].time;
            const t2 = this.waypoints[i + 1].time;
            const T1 = this.waypoints[i].temp;
            const T2 = this.waypoints[i + 1].temp;
            
            const fraction = (t - t1) / (t2 - t1);
            return T1 + fraction * (T2 - T1);
        });
        
        // Calculate metadata
        const maxTemp = Math.max(...temps);
        const duration = times[times.length - 1] - times[0];
        
        return {
            times: times,
            temps: temps,
            metadata: {
                name: this.currentProfile?.metadata.name || 'Custom Profile',
                description: 'User-edited profile',
                duration: duration,
                startTemp: temps[0],
                maxTemp: maxTemp,
                finalTemp: temps[temps.length - 1],
                nWaypoints: this.waypoints.length,
                edited: new Date().toISOString()
            }
        };
    }
}
