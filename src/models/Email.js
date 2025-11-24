import mongoose from 'mongoose';
import { validateEmail } from './validators.js';

const emailSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
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
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Account',
    default: null,
    validate: {
      validator: function(v) {
        if (!v) return true; // Allow null
        return mongoose.Types.ObjectId.isValid(v);
      },
      message: 'Account must be a valid ObjectId'
    }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save hook to update updatedAt
emailSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes
emailSchema.index({ email: 1 });

export const Email = mongoose.model('Email', emailSchema);

