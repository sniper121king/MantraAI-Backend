const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { createServer } = require('http');
const { Server: SocketServer } = require('socket.io');
const Anthropic = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');
const axios = require('axios');
require('dotenv').config();

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: "*", methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://admin:admin123@cluster0.mongodb.net/mantraai';
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✓ MongoDB connected');
}).catch(err => {
  console.log('✗ MongoDB error:', err.message);
});

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  createdAt: { type: Date, default: Date.now }
});

const conversationSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  title: String,
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  conversationId: mongoose.Schema.Types.ObjectId,
  role: String,
  content: String,
  model: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);
const Message = mongoose.model('Message', messageSchema);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function callAI(message, model) {
  try {
    if (model === 'claude') {
      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [{ role: 'user', content: message }]
      });
      return response.content[0].text;
    } 
    else if (model === 'gpt4') {
      const response = await openai.chat.completions.create({
        model: 'gpt-4-turbo',
        messages: [{ role: 'user', content: message }],
        max_tokens: 1024
      });
      return response.choices[0].message.content;
    }
    else if (model === 'gemini') {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`,
        { contents: [{ parts: [{ text: message }] }] },
        { params: { key: process.env.GOOGLE_API_KEY } }
      );
      return response.data.candidates[0].content.parts[0].text;
    }
    else if (model === 'cohere') {
      const response = await axios.post(
        'https://api.cohere.ai/v1/generate',
        { prompt: message, max_tokens: 1024, temperature: 0.8 },
        { headers: { Authorization: `Bearer ${process.env.COHERE_API_KEY}`, 'Content-Type': 'application/json' } }
      );
      return response.data.generations[0].text;
    }
    return 'Model not supported';
  } catch (error) {
    console.error('AI error:', error.message);
    return 'Error: ' + error.message;
  }
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const user = new User({ email, password, name });
    await user.save();
    res.status(201).json({ message: 'User created', user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ message: 'Login successful', user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations', async (req, res) => {
  try {
    const { userId, title } = req.body;
    const conversation = new Conversation({ userId, title });
    await conversation.save();
    res.json(conversation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:userId', async (req, res) => {
  try {
    const conversations = await Conversation.find({ userId: req.params.userId });
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/messages/:conversationId', async (req, res) => {
  try {
    const messages = await Message.find({ conversationId: req.params.conversationId });
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

io.on('connection', (socket) => {
  console.log('🟢 User connected:', socket.id);

  socket.on('join_conversation', (data) => {
    socket.join(`conversation_${data.conversationId}`);
    console.log(`User joined: ${data.conversationId}`);
  });

  socket.on('send_message', async (data) => {
    const { conversationId, message, model = 'claude' } = data;

    try {
      const userMsg = new Message({
        conversationId,
        role: 'user',
        content: message,
        model
      });
      await userMsg.save();

      const aiResponse = await callAI(message, model);

      const aiMsg = new Message({
        conversationId,
        role: 'assistant',
        content: aiResponse,
        model
      });
      await aiMsg.save();

      io.to(`conversation_${conversationId}`).emit('message_response', {
        userMsg,
        aiMsg
      });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('🔴 User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 MantraAI Server running on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
});
