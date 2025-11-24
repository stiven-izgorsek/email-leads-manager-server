import mongoose from 'mongoose';

const subjectTemplateSchema = new mongoose.Schema({
  content: {
    type: String,
    required: [true, 'Subject template content is required'],
    trim: true,
    minlength: [1, 'Subject template content cannot be empty'],
    maxlength: [500, 'Subject template content cannot exceed 500 characters'],
    validate: {
      validator: function(v) {
        return v && v.trim().length > 0;
      },
      message: 'Subject template content cannot be empty or contain only whitespace'
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
subjectTemplateSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes
subjectTemplateSchema.index({ content: 'text' });
subjectTemplateSchema.index({ createdAt: -1 });

export const SubjectTemplate = mongoose.model('SubjectTemplate', subjectTemplateSchema);

