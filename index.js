const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Simple in-memory database (production-এ SQLite/Turso ব্যবহার করবে)
const db = {
  teachers: [{
    id: '1',
    email: process.env.ADMIN_EMAIL || 'teacher@example.com',
    password: bcrypt.hashSync(process.env.ADMIN_PASSWORD || '123456', 10),
    name: 'Main Teacher'
  }],
  students: [],
  attendance: []
};

// ==================== AUTH ROUTES ====================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const teacher = db.teachers.find(t => t.email === email);
  
  if (!teacher || !await bcrypt.compare(password, teacher.password)) {
    return res.status(401).json({ error: 'ইমেইল বা পাসওয়ার্ড ভুল!' });
  }
  
  const token = jwt.sign({ id: teacher.id }, process.env.JWT_SECRET || 'secret', { expiresIn: '30d' });
  res.json({ token, teacher: { id: teacher.id, name: teacher.name, email: teacher.email } });
});

// Middleware for auth
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'লগইন প্রয়োজন!' });
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.teacherId = decoded.id;
    next();
  } catch (err) {
    res.status(401).json({ error: 'সেশন শেষ! আবার লগইন করুন।' });
  }
};

// ==================== STUDENT ROUTES ====================
// সব স্টুডেন্ট দেখানো
app.get('/api/students', authMiddleware, (req, res) => {
  const students = db.students.map(s => ({
    ...s,
    attendanceCount: db.attendance.filter(a => a.studentId === s.id && 
      new Date(a.timestamp).toDateString() === new Date().toDateString()
    ).length
  }));
  res.json(students);
});

// নতুন স্টুডেন্ট যোগ করা
app.post('/api/students', authMiddleware, (req, res) => {
  const { name, nfcCardUID } = req.body;
  
  // চেক করবে UID আগে ব্যবহার হয়েছে কিনা
  if (db.students.find(s => s.nfcCardUID === nfcCardUID)) {
    return res.status(400).json({ error: 'এই কার্ড ইতিমধ্যে ব্যবহার করা হয়েছে!' });
  }
  
  const student = {
    id: Date.now().toString(),
    name,
    nfcCardUID,
    teacherId: req.teacherId,
    createdAt: new Date().toISOString()
  };
  
  db.students.push(student);
  res.status(201).json({ success: true, student });
});

// কার্ড আপডেট করা
app.put('/api/students/:id/card', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { nfcCardUID } = req.body;
  
  const student = db.students.find(s => s.id === id && s.teacherId === req.teacherId);
  if (!student) return res.status(404).json({ error: 'স্টুডেন্ট পাওয়া যায়নি!' });
  
  student.nfcCardUID = nfcCardUID;
  res.json({ success: true, student });
});

// ==================== ATTENDANCE ROUTES ====================
// NFC স্ক্যান থেকে উপস্থিতি রেকর্ড
app.post('/api/attendance', authMiddleware, (req, res) => {
  const { nfcCardUID } = req.body;
  
  // স্টুডেন্ট খোঁজা
  const student = db.students.find(s => 
    s.nfcCardUID === nfcCardUID && s.teacherId === req.teacherId
  );
  
  if (!student) {
    return res.status(404).json({ 
      success: false, 
      message: '❌ অচেনা কার্ড! এই কার্ড সিস্টেমে রেজিস্টার করা নেই।' 
    });
  }
  
  // ডুপ্লিকেট চেক (শেষ ১০ মিনিট)
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  const recentEntry = db.attendance.find(a => 
    a.studentId === student.id && new Date(a.timestamp) > tenMinAgo
  );
  
  if (recentEntry) {
    return res.json({
      success: true,
      alreadyMarked: true,
      message: '⚠️ ইতিমধ্যে উপস্থিতি রেকর্ড করা আছে!',
      studentName: student.name
    });
  }
  
  // নতুন এন্ট্রি
  const attendance = {
    id: Date.now().toString(),
    studentId: student.id,
    timestamp: new Date().toISOString(),
    method: 'NFC'
  };
  
  db.attendance.push(attendance);
  
  res.json({
    success: true,
    studentName: student.name,
    timestamp: attendance.timestamp,
    message: '✅ উপস্থিতি সফলভাবে রেকর্ড হয়েছে!'
  });
});

// আজকের উপস্থিতি রিপোর্ট
app.get('/api/attendance/today', authMiddleware, (req, res) => {
  const today = new Date().toDateString();
  
  const todayAttendance = db.students
    .filter(s => s.teacherId === req.teacherId)
    .map(student => {
      const attendance = db.attendance.find(a => 
        a.studentId === student.id && 
        new Date(a.timestamp).toDateString() === today
      );
      
      return {
        id: student.id,
        name: student.name,
        present: !!attendance,
        time: attendance ? attendance.timestamp : null
      };
    });
  
  res.json(todayAttendance);
});

// মাসিক রিপোর্ট
app.get('/api/attendance/monthly', authMiddleware, (req, res) => {
  const { month, year } = req.query;
  const targetMonth = parseInt(month) - 1; // JS months are 0-based
  const targetYear = parseInt(year);
  
  const students = db.students.filter(s => s.teacherId === req.teacherId);
  const report = students.map(student => {
    const studentAttendance = db.attendance.filter(a => {
      const date = new Date(a.timestamp);
      return a.studentId === student.id && 
             date.getMonth() === targetMonth && 
             date.getFullYear() === targetYear;
    });
    
    // Unique dates count
    const uniqueDates = [...new Set(studentAttendance.map(a => 
      new Date(a.timestamp).toDateString()
    ))];
    
    return {
      studentId: student.id,
      name: student.name,
      totalDays: uniqueDates.length,
      attendanceList: studentAttendance.map(a => ({
        date: new Date(a.timestamp).toISOString(),
        time: new Date(a.timestamp).toLocaleTimeString('bn-BD')
      }))
    };
  });
  
  res.json(report);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ NFC Attendance Server running on port ${PORT}`);
});

// For Vercel serverless
module.exports = app;
