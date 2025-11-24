import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { validateEmail } from './validators.js';

const userSchema = new mongoose.Schema({
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
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
    validate: {
      validator: function(v) {
        // Basic password strength validation
        return v && v.length >= 6;
      },
      message: 'Password must be at least 6 characters long'
    }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save hook to hash password
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) {
    this.updatedAt = Date.now();
    return next();
  }
  
  try {
    this.password = await bcrypt.hash(this.password, 10);
    this.updatedAt = Date.now();
    next();
  } catch (error) {
    next(error);
  }
});

// Pre-save hook to update updatedAt
userSchema.pre('save', function(next) {
  if (!this.isModified('password')) {
    this.updatedAt = Date.now();
  }
  next();
});

// Method to compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!candidatePassword) {
    return false;
  }
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    return false;
  }
};

export const User = mongoose.model('User', userSchema);

