import mongoose from 'mongoose';
import { validateEmail, validateURL, validatePhone, validateLinkedIn, validateMaxLength } from './validators.js';

const leadSchema = new mongoose.Schema({
  Email: {
    type: String,
    required: [true, 'Email is required'],
    lowercase: true,
    trim: true,
    validate: {
      validator: function(v) {
        return validateEmail(v);
      },
      message: 'Please provide a valid email address'
    },
    maxlength: [255, 'Email cannot exceed 255 characters']
  },
  status: {
    type: String,
    enum: {
      values: ['unused', 'sent', 'bad', 'bounced', 'opened', 'replied', 'demoed'],
      message: 'Status must be one of: unused, sent, bad, bounced, opened, replied, demoed'
    },
    default: 'unused',
    index: true
  },
  sentAt: {
    type: Date,
    default: null,
    validate: {
      validator: function(v) {
        if (!v) return true; // Allow null
        return v instanceof Date && !isNaN(v);
      },
      message: 'sentAt must be a valid date'
    }
  },
  assignedTo: {
    type: String,
    default: null,
    trim: true,
    maxlength: [255, 'Assigned to cannot exceed 255 characters']
  },
  firstName: {
    type: String,
    trim: true,
    maxlength: [255, 'First name cannot exceed 255 characters']
  },
  lastName: {
    type: String,
    trim: true,
    maxlength: [255, 'Last name cannot exceed 255 characters']
  },
  company: {
    type: String,
    trim: true,
    maxlength: [255, 'Company name cannot exceed 255 characters']
  },
  title: {
    type: String,
    trim: true,
    maxlength: [255, 'Title cannot exceed 255 characters']
  },
  phone: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        if (!v || v.trim() === '') return true; // Allow empty
        return validatePhone(v);
      },
      message: 'Please provide a valid phone number (7-15 digits)'
    },
    maxlength: [50, 'Phone number cannot exceed 50 characters']
  },
  linkedin: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        if (!v || v.trim() === '') return true; // Allow empty
        return validateLinkedIn(v);
      },
      message: 'Please provide a valid LinkedIn URL (e.g., https://linkedin.com/in/username)'
    },
    maxlength: [500, 'LinkedIn URL cannot exceed 500 characters']
  },
  website: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        if (!v || v.trim() === '') return true; // Allow empty
        return validateURL(v);
      },
      message: 'Please provide a valid website URL'
    },
    maxlength: [500, 'Website URL cannot exceed 500 characters']
  },
  city: {
    type: String,
    trim: true,
    maxlength: [255, 'City cannot exceed 255 characters']
  },
  state: {
    type: String,
    trim: true,
    maxlength: [255, 'State cannot exceed 255 characters']
  },
  country: {
    type: String,
    trim: true,
    maxlength: [255, 'Country cannot exceed 255 characters']
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save hook to update updatedAt
leadSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes
leadSchema.index({ Email: 1 });
leadSchema.index({ status: 1 });
leadSchema.index({ assignedTo: 1 });
leadSchema.index({ createdAt: -1 });

export const Lead = mongoose.model('Lead', leadSchema);

