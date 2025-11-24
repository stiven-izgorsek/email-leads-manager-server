import mongoose from 'mongoose';
import { validateEmail, validateMaxLength } from './validators.js';

const accountSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Account name is required'],
    trim: true,
    minlength: [1, 'Account name cannot be empty'],
    maxlength: [255, 'Account name cannot exceed 255 characters'],
    validate: {
      validator: function(v) {
        return v && v.trim().length > 0;
      },
      message: 'Account name cannot be empty or contain only whitespace'
    }
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
  mainEmail: {
    type: String,
    lowercase: true,
    trim: true,
    validate: {
      validator: function(v) {
        if (!v || v.trim() === '') return true; // Allow empty
        return validateEmail(v);
      },
      message: 'Please provide a valid email address'
    },
    maxlength: [255, 'Email cannot exceed 255 characters']
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save hook to update updatedAt
accountSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes
accountSchema.index({ name: 1 });
accountSchema.index({ mainEmail: 1 });

export const Account = mongoose.model('Account', accountSchema);

