import { ApiProperty } from '@nestjs/swagger';

export class CheckoutSessionResponseDto {
  @ApiProperty({ description: 'Redirect the browser here — this is a Stripe-hosted page.' })
  checkoutUrl: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'So the frontend can poll GET /api/orders/:id for the real outcome after Stripe redirects ' +
      'back. The success page itself proves nothing — only the webhook decides an order is paid.',
  })
  orderId: string;
}
