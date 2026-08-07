/**
 * Custom validators for Mongoose schemas
 */

/**
 * Validates email format
 */
export function validateEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validates URL format
 */
export function validateURL(url) {
  if (!url || url.trim() === '') return true; // Allow empty URLs
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates phone number format (flexible - allows various formats)
 */
export function validatePhone(phone) {
  if (!phone || phone.trim() === '') return true; // Allow empty phones
  // Remove common phone number characters for validation
  const cleaned = phone.replace(/[\s\-\(\)\+]/g, '');
  // Check if it contains only digits and has reasonable length (7-15 digits)
  return /^\d{7,15}$/.test(cleaned);
}

/**
 * Validates LinkedIn URL
 */
export function validateLinkedIn(linkedin) {
  if (!linkedin || linkedin.trim() === '') return true; // Allow empty
  const linkedinRegex = /^(https?:\/\/)?(www\.)?linkedin\.com\/.+/i;
  return linkedinRegex.test(linkedin);
}

/**
 * Validates that a string is not empty after trimming
 */
export function validateNotEmpty(value) {
  return value && typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates minimum length
 */
export function validateMinLength(minLength) {
  return function(value) {
    if (!value) return true; // Allow empty if not required
    return value.length >= minLength;
  };
}

/**
 * Validates maximum length
 */
export function validateMaxLength(maxLength) {
  return function(value) {
    if (!value) return true; // Allow empty if not required
    return value.length <= maxLength;
  };
}

