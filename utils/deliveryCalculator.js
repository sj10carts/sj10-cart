// utils/deliveryCalculator.js
const { parseShippingData } = require('./shippingDataParser');

// Standard volumetric divisor
const VOLUMETRIC_DIVISOR = 5000; 

const calculateDeliveryFee = (packageInformationString) => {
    const { length, width, height, weight } = parseShippingData(packageInformationString);
    
    // 1. Calculate Volumetric Weight
    const volumetricWeight = (length * width * height) / VOLUMETRIC_DIVISOR;
    
    // 2. Logic Correction: "Flyer" Check
    // If the actual weight is very light (< 1kg), assume it fits in a flyer.
    // We ignore the volumetric weight in this case to prevent massive charges for bad data.
    let chargeableWeight = weight;
    
    if (weight > 1.0) {
        // Only apply volumetric logic if the item is actually heavy enough to be a box
        chargeableWeight = Math.max(weight, volumetricWeight);
    }

    console.log(`[Delivery Calc] Dims: ${length}x${width}x${height} | Actual: ${weight} | Vol: ${volumetricWeight} | Final Chargeable: ${chargeableWeight}`);

    // 3. Pricing Logic (Standardized)
    if (chargeableWeight <= 0.5) return 200;  // Standard Flyer
    if (chargeableWeight <= 1.0) return 250;  // Large Flyer
    if (chargeableWeight <= 2.0) return 300;
    if (chargeableWeight <= 3.0) return 350;
    if (chargeableWeight <= 4.0) return 400;
    if (chargeableWeight <= 5.0) return 450;
    
    // Cap strictly to prevent "1450" shocks
    if (chargeableWeight > 20) return 1500; 

    // Heavy items > 5kg: Base 450 + 100 per extra kg
    if (chargeableWeight > 5) {
        const extraWeight = Math.ceil(chargeableWeight - 5);
        return 450 + (extraWeight * 100);
    }
    
    return 200; // Fallback
};

module.exports = { calculateDeliveryFee };