import { MentorBookingsController } from './mentor-bookings.controller';

describe('MentorBookingsController checkout origin', () => {
  function setup() {
    const bookings = {
      createBooking: jest.fn().mockResolvedValue({}),
      pay: jest.fn().mockResolvedValue({}),
    };
    const origins = {
      resolve: jest.fn().mockReturnValue('https://www.skillbridgebuilder.com'),
    };
    const controller = new MentorBookingsController(bookings as never, origins as never);
    return { bookings, origins, controller };
  }

  it('forwards the resolved origin when creating a mentor booking checkout', async () => {
    const { bookings, origins, controller } = setup();
    const dto = {
      mentorProfileId: 'mentor-profile-1',
      slotId: 'slot-1',
      studentGoal: 'Review my backend architecture before launch.',
    };

    await controller.create(
      { userId: 'student-1' } as never,
      dto,
      'https://www.skillbridgebuilder.com',
      'https://www.skillbridgebuilder.com/ecosystem/mentor/backend',
    );

    expect(origins.resolve).toHaveBeenCalledWith(
      'https://www.skillbridgebuilder.com',
      'https://www.skillbridgebuilder.com/ecosystem/mentor/backend',
    );
    expect(bookings.createBooking).toHaveBeenCalledWith(
      'student-1',
      dto,
      'https://www.skillbridgebuilder.com',
    );
  });

  it('forwards the resolved origin when retrying mentor payment', async () => {
    const { bookings, controller } = setup();

    await controller.pay(
      { userId: 'student-1' } as never,
      'booking-1',
      'https://www.skillbridgebuilder.com',
      undefined,
    );

    expect(bookings.pay).toHaveBeenCalledWith(
      'student-1',
      'booking-1',
      'https://www.skillbridgebuilder.com',
    );
  });
});
