import { AppDataSource } from '../config/database.js';
import { User } from '../entities/User.js';
import { generateToken } from '../middleware/auth.js';
import bcrypt from 'bcryptjs';

export async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const userRepository = AppDataSource.getRepository(User);
    let user = await userRepository.findOne({ 
      where: { email: email.toLowerCase() } 
    });

    if (!user) {
      // Create user with default password if email-based auth is used
      const defaultPassword = password || 'default-password-123';
      const hashedPassword = await bcrypt.hash(defaultPassword, 10);
      user = userRepository.create({
        email: email.toLowerCase(),
        password: hashedPassword,
        role: 'VA'
      });
      user = await userRepository.save(user);
    } else if (password) {
      // If password provided, verify it
      const isValid = await user.comparePassword(password);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }

    const token = generateToken(user);

    // Set cookies
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.cookie('email', user.email, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ 
      message: 'Login successful',
      token,
      user: { id: user.id, email: user.email }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function register(req, res) {
  try {
    const { email, password } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const userRepository = AppDataSource.getRepository(User);
    
    // Check if user already exists
    const existingUser = await userRepository.findOne({ 
      where: { email: email.toLowerCase() } 
    });
    if (existingUser) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    const user = userRepository.create({
      email: email.toLowerCase(),
      password: hashedPassword,
      role: 'VA'
    });
    await userRepository.save(user);

    const token = generateToken(user);

    // Set cookies
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.cookie('email', user.email, {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ 
      message: 'Registration successful',
      token,
      user: { id: user.id, email: user.email }
    });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === '23505') { // PostgreSQL unique violation
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function logout(req, res) {
  res.clearCookie('token');
  res.clearCookie('email');
  res.json({ message: 'Logout successful' });
}

