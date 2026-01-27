<?php
/**
 * Notification Handler
 *
 * Email notifications
 *
 * @package Kelbe_Project_Tracker
 */

// Exit if accessed directly
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Notification Handler class
 */
class KPT_Notification_Handler {
    
    /**
     * Single instance of the class
     *
     * @var KPT_Notification_Handler
     */
    private static $instance = null;
    
    /**
     * Get instance
     *
     * @return KPT_Notification_Handler
     */
    public static function get_instance() {
        if (null === self::$instance) {
            self::$instance = new self();
        }
        return self::$instance;
    }
    
    /**
     * Constructor
     */
    private function __construct() {
        add_filter('wp_mail_from', array($this, 'set_mail_from'));
        add_filter('wp_mail_from_name', array($this, 'set_mail_from_name'));
    }
    
    /**
     * Send notification
     *
     * @param string $to Recipient email
     * @param string $subject Email subject
     * @param string $template Template name
     * @param array $data Template data
     * @return bool True on success, false on failure
     */
    public function send_notification($to, $subject, $template, $data = array()) {
        if (!is_email($to)) {
            return false;
        }
        
        // Get email content
        $content = $this->get_template_content($template, $data);
        
        if (!$content) {
            return false;
        }
        
        // Set headers for HTML email
        $headers = array(
            'Content-Type: text/html; charset=UTF-8',
        );
        
        // Send email
        $sent = wp_mail($to, $subject, $content, $headers);
        
        do_action('kpt_notification_sent', $to, $subject, $template, $sent);
        
        return $sent;
    }
    
    /**
     * Get template content
     *
     * @param string $template Template name
     * @param array $data Template data
     * @return string|false Email content or false
     */
    private function get_template_content($template, $data) {
        $settings = get_option('kpt_settings', array());
        $company_name = isset($settings['company_name']) ? $settings['company_name'] : get_bloginfo('name');
        
        // Start output buffering
        ob_start();
        
        // Include header
        $this->include_email_header($company_name);
        
        // Include template
        switch ($template) {
            case 'team_member_added':
                $this->template_team_member_added($data);
                break;
                
            case 'bid_submitted':
                $this->template_bid_submitted($data);
                break;
                
            case 'bid_accepted':
                $this->template_bid_accepted($data);
                break;
                
            case 'bid_rejected':
                $this->template_bid_rejected($data);
                break;
                
            case 'bid_revision_requested':
                $this->template_bid_revision_requested($data);
                break;
                
            case 'proposal_sent':
                $this->template_proposal_sent($data);
                break;
                
            case 'proposal_signed':
                $this->template_proposal_signed($data);
                break;
                
            case 'change_order_created':
                $this->template_change_order_created($data);
                break;
                
            case 'change_order_approved':
                $this->template_change_order_approved($data);
                break;
                
            case 'change_order_rejected':
                $this->template_change_order_rejected($data);
                break;
                
            case 'new_lead':
                $this->template_new_lead($data);
                break;
                
            case 'stage_completed':
                $this->template_stage_completed($data);
                break;
                
            default:
                $this->template_default($data);
                break;
        }
        
        // Include footer
        $this->include_email_footer($company_name);
        
        return ob_get_clean();
    }
    
    /**
     * Include email header
     *
     * @param string $company_name Company name
     */
    private function include_email_header($company_name) {
        ?>
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background: #f4f4f4; margin: 0; padding: 0; }
                .container { max-width: 600px; margin: 20px auto; background: #fff; border-radius: 8px; overflow: hidden; }
                .header { background: #D6001C; color: #fff; padding: 20px; text-align: center; }
                .header h1 { margin: 0; font-size: 24px; }
                .content { padding: 30px; }
                .button { display: inline-block; padding: 12px 24px; background: #D6001C; color: #fff; text-decoration: none; border-radius: 4px; margin: 20px 0; }
                .footer { background: #f9f9f9; padding: 20px; text-align: center; color: #666; font-size: 14px; }
                .info-box { background: #f9f9f9; border-left: 4px solid #D6001C; padding: 15px; margin: 20px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1><?php echo esc_html($company_name); ?></h1>
                </div>
                <div class="content">
        <?php
    }
    
    /**
     * Include email footer
     *
     * @param string $company_name Company name
     */
    private function include_email_footer($company_name) {
        ?>
                </div>
                <div class="footer">
                    <p>&copy; <?php echo date('Y') . ' ' . esc_html($company_name); ?></p>
                    <p><?php esc_html_e('This is an automated message. Please do not reply to this email.', 'kelbe-project-tracker'); ?></p>
                </div>
            </div>
        </body>
        </html>
        <?php
    }
    
    /**
     * Template: Team member added
     */
    private function template_team_member_added($data) {
        ?>
        <h2><?php esc_html_e('You\'ve Been Added to a Project', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('You have been added to the project: <strong>%s</strong>', 'kelbe-project-tracker'), esc_html($data['project_title'])); ?></p>
        <div class="info-box">
            <p><strong><?php esc_html_e('Role:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['role']); ?></p>
            <?php if (!empty($data['trade_type'])) : ?>
                <p><strong><?php esc_html_e('Trade Type:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['trade_type']); ?></p>
            <?php endif; ?>
        </div>
        <a href="<?php echo esc_url(home_url('/team-portal')); ?>" class="button"><?php esc_html_e('View Project', 'kelbe-project-tracker'); ?></a>
        <?php
    }
    
    /**
     * Template: Bid submitted
     */
    private function template_bid_submitted($data) {
        ?>
        <h2><?php esc_html_e('New Bid Submitted', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('A new bid has been submitted for project: <strong>%s</strong>', 'kelbe-project-tracker'), esc_html($data['project_title'])); ?></p>
        <div class="info-box">
            <p><strong><?php esc_html_e('Bid Number:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['bid_number']); ?></p>
            <p><strong><?php esc_html_e('Trade Type:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['trade_type']); ?></p>
            <p><strong><?php esc_html_e('Total:', 'kelbe-project-tracker'); ?></strong> $<?php echo number_format($data['total'], 2); ?></p>
        </div>
        <a href="<?php echo esc_url(admin_url('admin.php?page=kpt-bids')); ?>" class="button"><?php esc_html_e('Review Bid', 'kelbe-project-tracker'); ?></a>
        <?php
    }
    
    /**
     * Template: Bid accepted
     */
    private function template_bid_accepted($data) {
        ?>
        <h2><?php esc_html_e('Bid Accepted', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('Your bid <strong>%s</strong> has been accepted!', 'kelbe-project-tracker'), esc_html($data['bid_number'])); ?></p>
        <p><?php printf(__('Project: <strong>%s</strong>', 'kelbe-project-tracker'), esc_html($data['project_title'])); ?></p>
        <a href="<?php echo esc_url(home_url('/team-portal')); ?>" class="button"><?php esc_html_e('View Details', 'kelbe-project-tracker'); ?></a>
        <?php
    }
    
    /**
     * Template: Bid rejected
     */
    private function template_bid_rejected($data) {
        ?>
        <h2><?php esc_html_e('Bid Status Update', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('Your bid <strong>%s</strong> has been reviewed.', 'kelbe-project-tracker'), esc_html($data['bid_number'])); ?></p>
        <p><?php esc_html_e('Unfortunately, we have decided to go with a different proposal at this time. Thank you for your submission.', 'kelbe-project-tracker'); ?></p>
        <?php
    }
    
    /**
     * Template: Bid revision requested
     */
    private function template_bid_revision_requested($data) {
        ?>
        <h2><?php esc_html_e('Bid Revision Requested', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('A revision has been requested for your bid <strong>%s</strong>.', 'kelbe-project-tracker'), esc_html($data['bid_number'])); ?></p>
        <?php if (!empty($data['revision_notes'])) : ?>
            <div class="info-box">
                <p><strong><?php esc_html_e('Revision Notes:', 'kelbe-project-tracker'); ?></strong></p>
                <p><?php echo nl2br(esc_html($data['revision_notes'])); ?></p>
            </div>
        <?php endif; ?>
        <a href="<?php echo esc_url(home_url('/team-portal')); ?>" class="button"><?php esc_html_e('Update Bid', 'kelbe-project-tracker'); ?></a>
        <?php
    }
    
    /**
     * Template: Proposal sent
     */
    private function template_proposal_sent($data) {
        ?>
        <h2><?php esc_html_e('Your Proposal is Ready', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('We\'re excited to share our proposal for your project: <strong>%s</strong>', 'kelbe-project-tracker'), esc_html($data['project_title'])); ?></p>
        <div class="info-box">
            <p><strong><?php esc_html_e('Proposal Number:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['proposal_number']); ?></p>
            <p><strong><?php esc_html_e('Total:', 'kelbe-project-tracker'); ?></strong> $<?php echo number_format($data['total'], 2); ?></p>
        </div>
        <a href="<?php echo esc_url($data['proposal_url']); ?>" class="button"><?php esc_html_e('View Proposal', 'kelbe-project-tracker'); ?></a>
        <?php
    }
    
    /**
     * Template: Proposal signed
     */
    private function template_proposal_signed($data) {
        ?>
        <h2><?php esc_html_e('Proposal Signed!', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('Great news! The proposal <strong>%s</strong> has been signed.', 'kelbe-project-tracker'), esc_html($data['proposal_number'])); ?></p>
        <div class="info-box">
            <p><strong><?php esc_html_e('Project:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['project_title']); ?></p>
            <p><strong><?php esc_html_e('Total:', 'kelbe-project-tracker'); ?></strong> $<?php echo number_format($data['total'], 2); ?></p>
        </div>
        <a href="<?php echo esc_url(get_edit_post_link($data['project_id'])); ?>" class="button"><?php esc_html_e('View Project', 'kelbe-project-tracker'); ?></a>
        <?php
    }
    
    /**
     * Template: Change order created
     */
    private function template_change_order_created($data) {
        ?>
        <h2><?php esc_html_e('New Change Order', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('A new change order has been created for: <strong>%s</strong>', 'kelbe-project-tracker'), esc_html($data['project_title'])); ?></p>
        <div class="info-box">
            <p><strong><?php esc_html_e('Title:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['order_title']); ?></p>
            <p><strong><?php esc_html_e('Amount:', 'kelbe-project-tracker'); ?></strong> $<?php echo number_format($data['amount'], 2); ?></p>
        </div>
        <?php
    }
    
    /**
     * Template: Change order approved
     */
    private function template_change_order_approved($data) {
        ?>
        <h2><?php esc_html_e('Change Order Approved', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('The change order <strong>%s</strong> has been approved.', 'kelbe-project-tracker'), esc_html($data['order_title'])); ?></p>
        <div class="info-box">
            <p><strong><?php esc_html_e('Amount:', 'kelbe-project-tracker'); ?></strong> $<?php echo number_format($data['amount'], 2); ?></p>
        </div>
        <?php
    }
    
    /**
     * Template: Change order rejected
     */
    private function template_change_order_rejected($data) {
        ?>
        <h2><?php esc_html_e('Change Order Status', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('The change order <strong>%s</strong> has been rejected.', 'kelbe-project-tracker'), esc_html($data['order_title'])); ?></p>
        <?php
    }
    
    /**
     * Template: New lead
     */
    private function template_new_lead($data) {
        ?>
        <h2><?php esc_html_e('New Lead Received', 'kelbe-project-tracker'); ?></h2>
        <p><?php esc_html_e('A new lead has been submitted:', 'kelbe-project-tracker'); ?></p>
        <div class="info-box">
            <p><strong><?php esc_html_e('Name:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['first_name'] . ' ' . $data['last_name']); ?></p>
            <p><strong><?php esc_html_e('Email:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['email']); ?></p>
            <?php if (!empty($data['phone'])) : ?>
                <p><strong><?php esc_html_e('Phone:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['phone']); ?></p>
            <?php endif; ?>
            <?php if (!empty($data['project_type'])) : ?>
                <p><strong><?php esc_html_e('Project Type:', 'kelbe-project-tracker'); ?></strong> <?php echo esc_html($data['project_type']); ?></p>
            <?php endif; ?>
            <?php if (!empty($data['project_description'])) : ?>
                <p><strong><?php esc_html_e('Description:', 'kelbe-project-tracker'); ?></strong><br><?php echo nl2br(esc_html($data['project_description'])); ?></p>
            <?php endif; ?>
        </div>
        <a href="<?php echo esc_url(admin_url('admin.php?page=kpt-leads')); ?>" class="button"><?php esc_html_e('View Lead', 'kelbe-project-tracker'); ?></a>
        <?php
    }
    
    /**
     * Template: Stage completed
     */
    private function template_stage_completed($data) {
        ?>
        <h2><?php esc_html_e('Stage Completed', 'kelbe-project-tracker'); ?></h2>
        <p><?php printf(__('Stage %d has been completed for project: <strong>%s</strong>', 'kelbe-project-tracker'), $data['stage'], esc_html($data['project_title'])); ?></p>
        <?php
    }
    
    /**
     * Template: Default
     */
    private function template_default($data) {
        ?>
        <p><?php echo isset($data['message']) ? wp_kses_post($data['message']) : ''; ?></p>
        <?php
    }
    
    /**
     * Set mail from address
     *
     * @param string $email From email
     * @return string Modified from email
     */
    public function set_mail_from($email) {
        $settings = get_option('kpt_settings', array());
        $company_email = isset($settings['company_email']) ? $settings['company_email'] : '';
        
        return $company_email ? $company_email : $email;
    }
    
    /**
     * Set mail from name
     *
     * @param string $name From name
     * @return string Modified from name
     */
    public function set_mail_from_name($name) {
        $settings = get_option('kpt_settings', array());
        $company_name = isset($settings['company_name']) ? $settings['company_name'] : '';
        
        return $company_name ? $company_name : $name;
    }
    
    /**
     * Send bulk notification
     *
     * @param array $recipients Recipient emails
     * @param string $subject Email subject
     * @param string $template Template name
     * @param array $data Template data
     * @return array Results (sent/failed counts)
     */
    public function send_bulk_notification($recipients, $subject, $template, $data = array()) {
        $sent = 0;
        $failed = 0;
        
        foreach ($recipients as $recipient) {
            if ($this->send_notification($recipient, $subject, $template, $data)) {
                $sent++;
            } else {
                $failed++;
            }
        }
        
        return array(
            'sent' => $sent,
            'failed' => $failed,
        );
    }
}
