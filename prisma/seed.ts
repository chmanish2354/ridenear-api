import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required to seed');
}

const pool = new pg.Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const vehicles = [
  {
    make: 'Hyundai',
    model: 'Creta',
    year: 2022,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 2800,
    securityDeposit: 5000,
    lat: 12.9719,
    lng: 77.6412,
    status: 'available',
  },
  {
    make: 'Kia',
    model: 'Seltos',
    year: 2023,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 2600,
    securityDeposit: 5000,
    lat: 12.9352,
    lng: 77.6245,
    status: 'available',
  },
  {
    make: 'Toyota',
    model: 'Innova Crysta',
    year: 2021,
    type: 'muv',
    transmission: 'manual',
    fuel: 'diesel',
    seats: 7,
    pricePerDay: 3200,
    securityDeposit: 7000,
    lat: 12.9833,
    lng: 77.594,
    status: 'available',
  },
  {
    make: 'Maruti',
    model: 'Brezza',
    year: 2020,
    type: 'suv',
    transmission: 'manual',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 1800,
    securityDeposit: 3000,
    lat: 12.9591,
    lng: 77.6466,
    status: 'available',
  },
  {
    make: 'Honda',
    model: 'City',
    year: 2022,
    type: 'sedan',
    transmission: 'automatic',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 2200,
    securityDeposit: 4000,
    lat: 12.9784,
    lng: 77.6408,
    status: 'available',
  },
  {
    make: 'Tata',
    model: 'Nexon',
    year: 2023,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 2400,
    securityDeposit: 4000,
    lat: 12.9279,
    lng: 77.6271,
    status: 'available',
  },
  {
    make: 'Hyundai',
    model: 'i20',
    year: 2019,
    type: 'hatchback',
    transmission: 'manual',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 1200,
    securityDeposit: 2000,
    lat: 12.9698,
    lng: 77.598,
    status: 'available',
  },
  {
    make: 'Mahindra',
    model: 'XUV700',
    year: 2022,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'diesel',
    seats: 7,
    pricePerDay: 4500,
    securityDeposit: 8000,
    lat: 12.9141,
    lng: 77.6101,
    status: 'available',
  },
  {
    make: 'MG',
    model: 'Hector',
    year: 2021,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'petrol',
    seats: 5,
    pricePerDay: 3000,
    securityDeposit: 6000,
    lat: 13.001,
    lng: 77.571,
    status: 'available',
  },
  {
    make: 'Toyota',
    model: 'Fortuner',
    year: 2020,
    type: 'suv',
    transmission: 'automatic',
    fuel: 'diesel',
    seats: 7,
    pricePerDay: 5500,
    securityDeposit: 10000,
    lat: 12.935,
    lng: 77.535,
    status: 'maintenance',
  },
] as const;

async function main() {
  await prisma.reservation.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.user.deleteMany();

  const passwordHash = await bcrypt.hash('DRN(DiscoverRideNear)#2026', 10);

  await prisma.user.create({
    data: {
      name: 'Priya Sharma',
      email: 'priya@ridenear.demo',
      passwordHash,
      defaultLat: 12.9756,
      defaultLng: 77.6068,
    },
  });

  for (const vehicle of vehicles) {
    await prisma.vehicle.create({
      data: {
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        type: vehicle.type,
        transmission: vehicle.transmission,
        fuel: vehicle.fuel,
        seats: vehicle.seats,
        pricePerDay: vehicle.pricePerDay,
        securityDeposit: vehicle.securityDeposit,
        status: vehicle.status,
        currentLat: vehicle.lat,
        currentLng: vehicle.lng,
        anchorLat: vehicle.lat,
        anchorLng: vehicle.lng,
        imageUrl: '',
      },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
