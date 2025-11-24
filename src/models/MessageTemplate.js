import mongoose from 'mongoose';

const messageTemplateSchema = new mongoose.Schema({
  content: {
    type: String,
    required: [true, 'Message template content is required'],
    trim: true,
    minlength: [1, 'Message template content cannot be empty'],
    validate: {
      validator: function(v) {
        return v && v.trim().length > 0;
      },
      message: 'Message template content cannot be empty or contain only whitespace'
    }
  },
  industry: {
    type: String,
    trim: true,
    maxlength: [255, 'Industry cannot exceed 255 characters']
  },
  skills: {
    type: [{
      type: String,
      trim: true,
      maxlength: [100, 'Skill name cannot exceed 100 characters']
    }],
    default: [],
    validate: {
      validator: function(v) {
        // Remove empty strings and duplicates
        const uniqueSkills = [...new Set(v.filter(skill => skill && skill.trim().length > 0))];
        return uniqueSkills.length === v.length || v.length === 0;
      },
      message: 'Skills array cannot contain empty or duplicate values'
    }
  },
  used: {
    type: Number,
    default: 0,
    min: [0, 'Used count cannot be negative'],
    validate: {
      validator: Number.isInteger,
      message: 'Used count must be an integer'
    }
  },
  replied: {
    type: Number,
    default: 0,
    min: [0, 'Replied count cannot be negative'],
    validate: {
      validator: Number.isInteger,
      message: 'Replied count must be an integer'
    }
  },
  succeeded: {
    type: Number,
    default: 0,
    min: [0, 'Succeeded count cannot be negative'],
    validate: {
      validator: Number.isInteger,
      message: 'Succeeded count must be an integer'
    }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save hook to update updatedAt
messageTemplateSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes
messageTemplateSchema.index({ content: 'text', industry: 'text' });
messageTemplateSchema.index({ industry: 1 });
messageTemplateSchema.index({ createdAt: -1 });

export const MessageTemplate = mongoose.model('MessageTemplate', messageTemplateSchema);

