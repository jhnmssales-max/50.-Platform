const jwt = require('jsonwebtoken');
const [, , secret, sub] = process.argv;
console.log(jwt.sign({ sub, role: 'authenticated', aud: 'authenticated' }, secret, { algorithm: 'HS256', expiresIn: '2h' }));
