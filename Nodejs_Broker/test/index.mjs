import mqtt from 'mqtt';

const brokerUrl = 'mqtt+unix:///tmp/mqtt/mqtt.sock'; // Replace with your broker URL
const client = mqtt.connect(brokerUrl);

client.on('connect', () => {
  console.log('Connected to MQTT broker');

  // Subscribe to a topic
  client.subscribe('test/topic', (err) => {
    if (!err) {
      console.log('Subscribed to test/topic');
    }
  });
});

client.on('message', (topic, message) => {
  // message is a Buffer
  console.log(`Received message on ${topic}: ${message.toString()}`);
});


// Publish a message to the topic
setInterval(() => {
  const message = 'Hello MQTT';
  client.publish('test/topic', message);
  console.log(`Published message: ${message}`);
}, 1000);

